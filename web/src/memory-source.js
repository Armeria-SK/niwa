const when = value => { const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; };

/** 記憶がいつ、どの会話の誰の発言から生まれたかを、画面に出す短い文にする。元の会話が消えていればそう書く。 */
export function memorySource(item) {
  const source = item.source;
  const said = source?.excerpt !== undefined;
  return {
    created: when(item.created_at),
    room: source ? source.room_title : '元の会話は削除されています',
    private: !!source?.private,
    excerpt: said ? source.excerpt : '',
    author: !said ? '' : source.author_id === 'administrator' ? 'あなた' : source.author_name || '削除したBot',
    said: said ? when(source.said_at) : '',
    openable: !!source,
  };
}
