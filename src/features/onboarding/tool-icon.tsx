const paths = {
  check: <path d="m5 12.75 4.25 4.25L19 7.25" />,
  cursor: <path d="M6 4.5v13l3.6-3.2 2.6 5.2 2.4-1.2-2.6-5.1 4.9-.4z" />,
  highlighter: <><path d="m14.5 4.5 5 5-8.5 8.5-5-5z" /><path d="m6 13-1.5 5.5L11 18M13 20.5h7" /></>,
  mic: <><rect x="9" y="3.5" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5M9 20.5h6" /></>,
  browser: <><rect x="3" y="3.5" width="18" height="17" rx="3" /><path d="M3 8h18M8.5 17v-5.5h1.7a1.3 1.3 0 1 1 2.6 0H14.5v1.6a1.3 1.3 0 1 1 0 2.6V17z" /></>,
  laptop: <><rect x="5" y="5.5" width="14" height="10" rx="1.75" /><path d="M3 19h18" /></>,
};
export function ToolIcon({ name, size = 14 }: { name: keyof typeof paths; size?: number }) {
  return <svg className="tool-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
