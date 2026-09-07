export function MentionText({ text, members }) {
  const names = [...new Set(Object.values(members).map(member => member.name))].filter(Boolean).sort((a, b) => b.length - a.length)
    .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!names.length) return text;
  const boundary = '(?=$|[\\s、。,:：!?！？（）()「」\\[\\]@＠])';
  // Older messages may already contain the recipient prefix twice. Keep their stored text intact.
  for (const name of names) text = text.replace(new RegExp(`^([@＠]${name})(?:\\s+[@＠]${name})+${boundary}`, 'u'), '$1');
  const mention = new RegExp(`((?<![\\w.+%\\-])[@＠](?:${names.join('|')})${boundary})`, 'gu');
  return text.split(mention).map((part, index) => index % 2 ? <strong className="message-mention" key={index}>{part}</strong> : part);
}
