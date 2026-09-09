import {retainCompleteExchanges} from './context/retention.ts';
import {LEGACY_RULES as BASE_RULES} from './context/legacy-rules.ts';
import {structuredPrompt, scopedPromptTools, type PromptVersion} from './context/prompt.ts';
import type { Runtime } from './runtime.ts';
import type { Agent } from '../domain/types.ts';
import type { TaskLease } from '../domain/task.ts';
import type { ModelMessage, ModelRequest, ModelEvent, ModelToolCall } from '../contracts/model.ts';
import type { ModelAdapter } from '../providers/shared/adapter.ts';
import { collectModelEvents } from '../providers/shared/adapter.ts';
import { isReasoningEffort } from '../providers/shared/catalog.ts';
import { turnTools, executeAsyncTurnTool, type ExternalTools } from './turn-tools.ts';
import { ContextLimit, fitContext, type FittedContext } from './context/fit.ts';
import { Value } from '@sinclair/typebox/value';
import { memoryReviewSchema } from '../domain/memory-review.ts';
import { summarySchema } from '../domain/summary.ts';

/** Return a fresh adapter each time; calls after memory corrections must discard opaque continuation. */
export type ResolveAdapter = (agent: Agent, taskId: string, signal?: AbortSignal) => Promise<ModelAdapter>;


/** Runs one claimed task; model APIs never own the tool loop or the bot's lifetime. */
export class TurnRunner {
  #runtime: Runtime;
  #resolve: ResolveAdapter;
  #external: ExternalTools;
  #promptVersion: PromptVersion;
  constructor(runtime: Runtime, resolve: ResolveAdapter, external: ExternalTools = {}, options: {promptVersion?:PromptVersion} = {}) { this.#runtime = runtime; this.#resolve = resolve; this.#external = external; this.#promptVersion=options.promptVersion??'legacy-v4'; }

  async run(lease: TaskLease, signal?: AbortSignal): Promise<void> {
    const runtime = this.#runtime;
    const actor = runtime.agentSession(lease.task.agent_id);
    if (!runtime.tasks.active(actor, lease)) return;
    let agent = runtime.agents(actor).find(item => item.id === lease.task.agent_id)!;
    const history: ModelMessage[] = [];
    let adapter: ModelAdapter;
    try { adapter = await this.#resolve(agent, lease.task.id, signal); }
    catch {
      if (runtime.tasks.active(actor, lease)) runtime.tasks.wait(actor, lease, 'waiting_provider', 'モデル接続の設定・認証・能力確認が必要です。1分後に再確認します。', true);
      return;
    }
    const promptVersion=runtime.tasks.bindPrompt(actor,lease,this.#promptVersion);
    let saved = runtime.tasks.steps(actor, lease.task.id);
    let pendingCompletion: (typeof saved)[number] | undefined;
    let position = 0;
    let freshSteps = 0;
    const startedAt = Date.now();
    let historyRevision: number | undefined;
    while (runtime.tasks.active(actor, lease) && !signal?.aborted) {
      agent = runtime.agents(actor).find(item => item.id === lease.task.agent_id)!;
      const context = runtime.context(actor, lease.task.room_id);
      const rules = runtime.commonRules(actor);
      if (historyRevision !== undefined && historyRevision !== context.revision) {
        history.length = 0;
        pendingCompletion = undefined;
        position = 0;
        // Provider-owned opaque continuation may also contain the superseded memory.
        try { adapter = await this.#resolve(agent, lease.task.id, signal); }
        catch {
          if (runtime.tasks.active(actor, lease)) runtime.tasks.wait(actor, lease, 'waiting_provider', '記憶更新後のモデル接続を再作成できませんでした。1分後に再確認します。', true);
          return;
        }
        if (!runtime.tasks.active(actor, lease) || signal?.aborted) return;
        if (!runtime.isContextCurrent(actor, context.revision)) continue;
      }
      historyRevision = context.revision;
      let step: (typeof saved)[number] | undefined;
      if (pendingCompletion && !runtime.needsCompletionSummary(actor, lease)) { step = pendingCompletion; pendingCompletion = undefined; }
      else step = saved[position++];
      if (step && (step.discarded || step.memory_revision !== context.revision || step.rules_revision !== rules.revision)) {
        runtime.tasks.discardStep(actor, lease, step.step);
        continue;
      }
      const freshStep = !step;
      if (!step) {
        if (agent.provider === 'openai_subscription' && adapter.adapter_id === 'ollama') {
          try { adapter = await this.#resolve(agent, lease.task.id, signal); }
          catch { if (runtime.tasks.active(actor, lease)) runtime.tasks.wait(actor, lease, 'waiting_provider', '切替先のモデル接続を確認してください。1分後に再確認します。', true); return; }
          if (!runtime.tasks.active(actor, lease) || signal?.aborted) return;
          if (!runtime.isContextCurrent(actor, context.revision)) continue;
        }
        const roomMessages=runtime.messages(actor,lease.task.room_id);
        const selectedMessages=roomMessages.filter((message,index)=>promptVersion==='legacy-v4'||message.author_id==='administrator'||index>=roomMessages.length-24);
        const base: ModelMessage[] = selectedMessages.map(message => ({
          role: 'user', content: JSON.stringify({ message_id: message.id, author_id: message.author_id, text: message.body, ...(message.reply_to ? { reply_to: message.reply_to } : {}) }),
        }));
        const workState = runtime.tasks.workState(actor, lease);
        const reviewingMemory = base.length > 0 && !runtime.memoryReviewed(actor, lease);
        const phaseTool = reviewingMemory ? 'memory_review' : pendingCompletion ? 'task_summary_save' : undefined;
        const phaseSchema = phaseTool === 'memory_review' ? memoryReviewSchema : summarySchema;
        // Full external results remain in receipts and task_history_read, not duplicated in every request.
        const inputState = { ...workState, external_operations: workState.external_operations.map(({ result: _result, ...operation }) => operation),
          ...(phaseTool === 'task_summary_save' ? { summary_sources: runtime.completionSummarySources(actor, lease), proposed_completion: pendingCompletion!.events } : {}) };
        if (workState.autonomous && !adapter.capabilities.supports_tool_calls) {
          runtime.tasks.wait(actor, lease, 'waiting_provider', '自発活動には休息を選べるツール対応モデルが必要です。'); return;
        }
        const members = runtime.agents(actor).map(member => ({ id: member.id, name: member.name, role: member.role, status: member.status }));
        const recentCalls = history.filter(message => message.role === 'assistant').slice(-3)
          .map(message => JSON.stringify(message.tool_calls?.map(call => ({ name: call.name, arguments: call.arguments }))));
        const repeating = recentCalls.length === 3 && recentCalls.every(calls => calls === recentCalls[0]);
        const RULES = `${BASE_RULES}\n管理者が設定した共通の指示（権限と停止・予算の制約は引き続き守る）: ${rules.body}${repeating ? '\n同じ引数のツール操作が3回続いています。直近の結果を確認し、進展がなければ別の方法へ変更してください。' : ''}`;
        const sharedRoom = runtime.rooms(actor).find(room => room.id === lease.task.room_id)?.visibility === 'shared';
        let configuredTools = turnTools(agent.role === 'leader', this.#external, sharedRoom, workState.autonomous, !!this.#runtime.workareas.settings(actor).enabled);
        if(promptVersion==='structured-v5')configuredTools=scopedPromptTools(configuredTools,workState, runtime.initiatives.enabled());
        const settings = runtime.settings(actor);
        const environment = { conversation: sharedRoom ? 'shared' : 'private', model_supports_tools: adapter.capabilities.supports_tool_calls,
          configured_tools_here: configuredTools.map(tool => tool.name),
          configured_tools_in_shared_room: turnTools(agent.role === 'leader', this.#external, true).map(tool => tool.name),
          autonomous_enabled: settings.autonomous, activity_paused: settings.paused, this_task_autonomous: workState.autonomous,
          omitted_room_messages:roomMessages.length-selectedMessages.length, archived_tool_messages:history.length-(promptVersion==='structured-v5'?retainCompleteExchanges(history,8).length:history.length),
          execution_boundary: (this.#runtime.workareas.settings(actor).enabled&&this.#external.workareas?'個人・案件の作業場所が有効。workspace_selectで現在のBot・会話に許可された作業場所を選ぶと、私的会話でもその領域の書込・隔離実行が可能。未選択時の境界は次の通り。':'')+'program_runは共有会話の隔離コンテナ内。共有workspaceのみ書込可能、外部通信・ホスト操作不可。workspace_writeとweb_downloadも共有会話限定。自律活動は設定・停止・予算・予定・権限に従う。' };
        const recentHistory=promptVersion==='structured-v5'?retainCompleteExchanges(history,8):history;
        const trimmableConversation=promptVersion==='structured-v5'?base.filter((_m,i)=>selectedMessages[i]!.author_id!=='administrator'):base;
        const makeRequest = (): ModelRequest => ({
          system_instructions: `${RULES}\n現在の実行環境: ${JSON.stringify(environment)}${workState.autonomous ? '\n今回は自発活動の機会です。自分の関心・人格、最近の会話、過去の成果を確認し、管理者の方針の範囲で役立つ活動を自分で選んでください。毎回の発言や作業は必須ではありません。今は必要がなければtask_restを単独で呼んで休んでください。私的な経験をそのまま共有会話へ公開しないでください。' : ''}${workState.task.conversation_reply ? '\n今回は別のBotからあなたへの会話です。現在の依頼に応答し、返信相手がいる場合は@名前から始めてください。話題を引き継ぐ必要がなければ短く答えるか休息してください。' : ''}\nあなた: ${JSON.stringify({ id: agent.id, name: agent.name, role: agent.role, profile: runtime.profile(actor, agent.id) })}\nメンバー: ${JSON.stringify(members)}\n利用できる自分の記憶: ${JSON.stringify(context.memories.slice(-20).map(memory => ({ id: memory.id, body: memory.body })))}`,
          messages: [...base, { role: 'user', content: `現在の依頼: ${lease.task.prompt}` }, ...recentHistory,
            { role: 'user', content: JSON.stringify({ work_state: inputState }) }],
          tools: adapter.capabilities.supports_tool_calls ? configuredTools
            .filter(tool => !phaseTool || tool.name === phaseTool) : [],
          response_contract: { type: 'text' }, model_options: {},
          budget: { max_output_tokens: 4096, max_total_tokens: 64_000, max_requests: 1, max_tool_calls: 8 },
          ...(adapter.adapter_id === 'openai-subscription' && isReasoningEffort(agent.reasoning) ? { reasoning_effort: agent.reasoning } : {}),
        });
        const requestForPhase = (): ModelRequest => {
          const request = makeRequest();
          if (reviewingMemory) request.system_instructions += '\n現在は返答・作業の前の記憶整理です。表示された会話から今後も役立つ好み・合意・経験・継続した関心を最大5件選び、実在するmessage_idをsource_message_idに指定します。推測、挨拶、重複、認証情報、一時的な進捗は保存しません。他Botの発言を自分の経験と混同せず、発言者と不確かさを保ちます。既存記憶と矛盾する場合は勝手に上書きせず省きます。memory_reviewだけを呼んでください。保存不要ならmemoriesは空配列です。ツールがない場合は同じ引数のJSON {"memories":[{"source_message_id":"表示されたID","body":"短い記憶"}]} だけを返してください。通常の会話への返答は次の呼び出しで行います。';
          else if (phaseTool === 'task_summary_save') request.system_instructions += `\n現在は仕事を完了する前の引継ぎ整理です。保存済みの事実から結論・理由・未解決事項・次の手順を短くまとめ、task_summary_saveだけを呼んでください。proposed_completionはまだ送っていない返答候補であり、実行済みの証拠ではありません。sourcesにはsummary_sourcesで確認できるkind/source_id/revisionを使い、現在の仕事自体を出所にしません。要約は承認や実行記録を置き換えません。ツールがない場合はこの形式に合うJSONだけを返します: ${JSON.stringify(summarySchema)}`;
          return promptVersion==='structured-v5'?structuredPrompt(request,{rules,agent,profile:runtime.profile(actor,agent.id),members,memories:context.memories.slice(-20),memoryRevision:context.revision,environment,state:inputState,phase:phaseTool??'work',repeating}):request;
        };
        let fitted: FittedContext;
        try {
          fitted = fitContext(requestForPhase(), recentHistory, adapter.context_window, trimmableConversation);
          if (fitted.removed_messages || recentHistory.length!==history.length || selectedMessages.length!==roomMessages.length) {
            // The provider's opaque state must not reintroduce exchanges omitted from this input.
            adapter = await this.#resolve(agent, lease.task.id, signal);
            if (!runtime.tasks.active(actor, lease) || signal?.aborted) return;
            if (!runtime.isContextCurrent(actor, context.revision)) continue;
            fitted = fitContext(requestForPhase(), recentHistory, adapter.context_window, trimmableConversation);
          }
        } catch (error) {
          if (runtime.tasks.active(actor, lease)) runtime.tasks.wait(actor, lease, 'waiting_user',
            error instanceof ContextLimit ? error.message : '文脈の再構成またはモデル接続の再作成を完了できませんでした。');
          return;
        }
        if (!runtime.tasks.reserveModelCall(actor, lease)) {
          if (runtime.tasks.active(actor,lease)) runtime.tasks.wait(actor, lease, 'waiting_user', '定期実行のモデル呼び出し上限に達しました。'); return;
        }
        const promptRun=runtime.tasks.recordPrompt(actor,lease,{version:promptVersion,phase:phaseTool??'work',rules_revision:rules.revision,memory_revision:context.revision,input_bytes:fitted.input_bytes,estimated_input_tokens:fitted.estimated_input_tokens,removed_messages:fitted.removed_messages+history.length-recentHistory.length+roomMessages.length-selectedMessages.length});
        let events = await collectModelEvents(adapter.run(fitted.request, { timeout_ms: 600_000, ...(signal ? { signal } : {}) }),
          { ...(signal ? { signal } : {}), timeout_ms: 605_000, max_tool_calls: 8, max_total_bytes: 2 * 1024 * 1024 });
        runtime.tasks.finishPrompt(actor,lease,promptRun,events);
        if (!runtime.tasks.active(actor, lease) || signal?.aborted) return;
        if (!runtime.isContextCurrent(actor, context.revision)) continue;
        const failure = events.find(event => event.type === 'failed');
        if (failure) {
          if (failure.error.code === 'QUOTA_EXCEEDED' && adapter.adapter_id === 'openai-subscription') {
            try {
              const fallback = await this.#resolve(agent, lease.task.id, signal);
              if (fallback.adapter_id === 'ollama') { adapter = fallback; continue; }
            } catch { /* Leave a visible provider wait when the configured fallback is unavailable. */ }
          }
          const retry = failure.error.code === 'QUOTA_EXCEEDED' || !!lease.task.internal_autonomous;
          runtime.tasks.wait(actor, lease, 'waiting_provider', `モデル応答を完了できませんでした (${failure.error.code})。${retry ? (lease.task.internal_autonomous ? '待機後に接続先を再確認します。' : '1分後に接続先を再確認します。') : ''}`, retry);
          return;
        }
        if (phaseTool) {
          let review = events.filter(event => event.type === 'tool_call');
          if (!review.length && events.some(event => event.type === 'completed' && event.finish_reason === 'stop')) {
            try {
              const args: unknown = JSON.parse(events.filter(event => event.type === 'text_delta').map(event => event.text).join(''));
              if (Value.Check(phaseSchema, args)) {
                events = [{ type: 'tool_call', name: phaseTool, tool_call_id: phaseTool, arguments: args }, { type: 'completed', finish_reason: 'tool_calls' }];
                review = events.filter(event => event.type === 'tool_call');
              }
            } catch { /* Invalid review output must never become a public reply or another tool operation. */ }
          }
          if (review.length !== 1 || review[0]!.name !== phaseTool || !Value.Check(phaseSchema, review[0]!.arguments)) {
            runtime.tasks.wait(actor, lease, 'waiting_provider', 'モデルが記憶・引継ぎ整理の形式を返せませんでした。1分後に再確認します。', true); return;
          }
        }
        const index = runtime.tasks.saveStep(actor, lease, context.revision, events);
        step = { step: index, memory_revision: context.revision, rules_revision: rules.revision, discarded: 0, events: [...events] };
        saved.push(step);
        freshSteps++;
      }
      const calls: ModelToolCall[] = step.events.filter((event): event is Extract<ModelEvent, { type: 'tool_call' }> => event.type === 'tool_call')
        .map(({ name, tool_call_id, arguments: args }) => ({ name, tool_call_id, arguments: args }));
      const content = step.events.filter(event => event.type === 'text_delta').map(event => event.text).join('');
      const completing = calls.length === 1 && ['conversation_send', 'task_rest'].includes(calls[0]!.name) ||
        !calls.length && step.events.some(event => event.type === 'completed' && event.finish_reason === 'stop');
      if (completing && runtime.needsCompletionSummary(actor, lease)) { pendingCompletion = step; continue; }
      if (!calls.length) {
        const terminal = step.events.find(event => event.type === 'completed');
        if (!terminal || terminal.finish_reason !== 'stop') {
          runtime.tasks.wait(actor, lease, 'waiting_provider', 'モデルの応答が最後まで完了していません。');
          return;
        }
        runtime.tasks.once(actor, lease, `final:${step.step}`, { content }, () => {
          runtime.respond(actor, lease, content);
          return { completed: true };
        });
        return;
      }
      history.push({ role: 'assistant', content, tool_calls: calls });
      const mixedWait = calls.length > 1 && calls.some(call => ['execution_wait', 'activity_checkpoint', 'task_handoff', 'task_delegate', 'ask_user', 'approval_request', 'browser_form_submit', 'browser_request_submit', 'task_status_update', 'conversation_ack', 'task_rest', 'conversation_send'].includes(call.name));
      for (const [index, call] of calls.entries()) {
        const output = mixedWait ? { error: 'task_delegate, ask_user, task_rest and conversation_send must be called alone.' }
          : await executeAsyncTurnTool(runtime, actor, lease, call, `${step.step}:${index}`, signal, this.#external);
        history.push({ role: 'tool', name: call.name, tool_call_id: call.tool_call_id, content: JSON.stringify(output) });
        if (!runtime.tasks.active(actor, lease)) return;
        if (!runtime.isContextCurrent(actor, context.revision)) break;
      }
      saved = runtime.tasks.steps(actor, lease.task.id);
      if (freshStep && (freshSteps >= 4 || Date.now() - startedAt >= 10_000) && !pendingCompletion && runtime.tasks.yieldIfWaiting(actor, lease)) return;
    }
  }
}
