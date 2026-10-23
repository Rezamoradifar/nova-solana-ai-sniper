export function SiteBrand() {
  return (
    <span className="nova-site-brand" dir="ltr">
      <span className="nova-site-mark" aria-hidden="true">
        <svg viewBox="0 0 40 40" fill="none">
          <path
            d="M6 30V10l14 14 14-14v20"
            stroke="currentColor"
            strokeWidth="4.5"
            strokeLinejoin="round"
          />
          <path d="m20 24 14-14v20" stroke="#8b5cf6" strokeWidth="4.5" strokeLinejoin="round" />
        </svg>
      </span>
      <span>
        moneyland<span className="nova-site-dot">.</span>
        <small>POWERED BY GSP TRADING</small>
      </span>
    </span>
  );
}
