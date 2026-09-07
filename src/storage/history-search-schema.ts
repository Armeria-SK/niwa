const sources = [
  { table: 'messages', kind: 'message', id: 'id', room: (p: string) => `${p}.room_id`, body: (p: string) => `${p}.body` },
  { table: 'tasks', kind: 'task', id: 'id', room: (p: string) => `${p}.room_id`, body: (p: string) => `${p}.prompt || char(10) || coalesce(${p}.result,'')` },
  { table: 'task_replies', kind: 'task_reply', id: 'sequence', room: (p: string) => `(SELECT room_id FROM tasks WHERE id=${p}.task_id)`, body: (p: string) => `${p}.body` },
  { table: 'artifacts', kind: 'artifact', id: 'id', room: (p: string) => `${p}.room_id`, body: (p: string) => `${p}.name || char(10) || ${p}.description || char(10) || ${p}.content` },
];

/** Control-data index only; private bot memories keep their own database and index. */
export const historySearchSchema = `
CREATE VIRTUAL TABLE history_search USING fts5(kind UNINDEXED, source_id UNINDEXED, room_id UNINDEXED, body, tokenize='trigram');
` + sources.map(source => {
  const insert = (p: string) => `'${source.kind}',CAST(${p}.${source.id} AS TEXT),${source.room(p)},${source.body(p)}`;
  const remove = `DELETE FROM history_search WHERE kind='${source.kind}' AND source_id=CAST(old.${source.id} AS TEXT);`;
  return `
INSERT INTO history_search SELECT ${insert('source')} FROM ${source.table} source;
CREATE TRIGGER search_${source.table}_insert AFTER INSERT ON ${source.table} BEGIN
  INSERT INTO history_search VALUES (${insert('new')}); END;
CREATE TRIGGER search_${source.table}_update AFTER UPDATE ON ${source.table} BEGIN
  ${remove} INSERT INTO history_search VALUES (${insert('new')}); END;
CREATE TRIGGER search_${source.table}_delete AFTER DELETE ON ${source.table} BEGIN ${remove} END;
`;
}).join('');
