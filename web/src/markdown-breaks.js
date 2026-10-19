/** Chat keeps a single newline as a line break, as people and Bots expect. Code keeps its own text. */
export function remarkChatBreaks() {
  return tree => splitBreaks(tree);
}

function splitBreaks(node) {
  if (!Array.isArray(node.children)) return;
  node.children = node.children.flatMap(child => {
    if (child.type !== 'text' || !child.value.includes('\n')) { splitBreaks(child); return [child]; }
    return child.value.split(/\r?\n/).flatMap((value, i) => i ? [{ type: 'break' }, ...(value ? [{ type: 'text', value }] : [])] : value ? [{ type: 'text', value }] : []);
  });
}
