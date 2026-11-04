export function BrandName() {
  return <span className="brand-word">gloss</span>;
}

export function BrandLockup() {
  return (
    <span className="brand-lockup" aria-label="gloss">
      <span className="brand-tile" aria-hidden="true"><svg width="16" height="23" viewBox="0 0 16 23" focusable="false"><image href="/brand-mark.svg" width="16" height="23" /></svg></span>
      <span className="brand-name" aria-hidden="true">gloss</span>
    </span>
  );
}
