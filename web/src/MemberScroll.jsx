import { useLayoutEffect, useRef, useState } from 'react';

export function MemberScroll({ children }) {
  const list = useRef(null);
  const [position, setPosition] = useState({ overflow: false, top: true, bottom: true });
  function update() {
    const element = list.current;
    if (!element) return;
    const next = { overflow: element.scrollHeight > element.clientHeight + 1, top: element.scrollTop <= 1, bottom: element.scrollTop + element.clientHeight >= element.scrollHeight - 1 };
    setPosition(current => Object.keys(next).every(key => current[key] === next[key]) ? current : next);
  }
  useLayoutEffect(() => {
    const element = list.current;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    update();
    return () => observer.disconnect();
  }, [children]);
  function scroll(direction) {
    const element = list.current;
    element.scrollBy({ top: direction * Math.max(64, element.clientHeight * 0.7), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }
  return <div className="member-list-shell">
    <div className="member-list" ref={list} onScroll={update} tabIndex={0} aria-label="メンバー一覧">{children}</div>
    {position.overflow ? <div className="member-scroll-controls">
      <button type="button" className="member-scroll-up" aria-label="メンバー一覧を上へスクロール" disabled={position.top} onClick={() => scroll(-1)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 10 4-4 4 4" /></svg></button>
      <button type="button" className="member-scroll-down" aria-label="メンバー一覧を下へスクロール" disabled={position.bottom} onClick={() => scroll(1)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></button>
    </div> : null}
  </div>;
}