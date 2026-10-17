/** 書き出す中身を一行で。人格と見た目はいつも入り、手順と記憶は選んだ数だけ。 */
export function exportSummary(procedures = 0, memories = 0) {
  return `人格・見た目${procedures ? `・手順${procedures}件` : ''}${memories ? `・記憶${memories}件` : ''}`;
}

/** 個別の会話から生まれて選べないものの知らせ。0件なら空。 */
export function privateNote(procedures = 0, memories = 0) {
  const parts = [procedures ? `手順${procedures}件` : '', memories ? `記憶${memories}件` : ''].filter(Boolean);
  return parts.length ? `個別の会話から生まれた${parts.join('と')}は、書き出せません。` : '';
}
