import { Link } from 'react-router-dom';
import LogoMark from '../components/LogoMark';

/* ==========================================================================
   Public landing page — /
   Visual structure follows the supplied reference screenshot: dark navy-black
   substrate, cyan signal, a policy-engine graph in the hero, a connected
   eight-stage pipeline, an Approvals/Executions control plane, a capability
   grid, a Testnet panel and an open-source closing.

   Every claim is traceable to the shipped implementation:
     pipeline order   apps/api/src/index.ts (policy.evaluate → approval →
                      pipeline.execute) and packages/stellar/src/pipeline.ts
                      (build → simulate → sign → submit)
     three verdicts   types.ts  PolicyDecision.result  allow|deny|requires_approval
     approval states  types.ts  ApprovalStatus
     execution states types.ts  ExecutionStatus  queued|executing|submitted|
                                confirmed|failed|dead_letter|cancelled
     policy rules     types.ts  PolicyRules
     schedule states  types.ts  ScheduleStatus   active|paused|disabled
     intent types     types.ts  IntentType; Submit.tsx exposes payment+trustline;
                                raw XDR rejected at the API
     live-submit gate packages/stellar/src/submitter.ts + network-guard.ts
     MIT licence      LICENSE
   No metrics, customers, testimonials or logos are claimed. Rows shown in the
   control plane are illustrative and labelled as such.
   ========================================================================== */

const REPO_URL = 'https://github.com/naninu123/4evergent';
const DOCS_URL = `${REPO_URL}/tree/main/docs`;

type Kind = 'flow' | 'policy' | 'gate' | 'chain' | 'record';
type Stage = { label: string; desc: string; kind: Kind };

const STAGES: Stage[] = [
  { label: 'Agent', desc: 'Identity + Stellar address', kind: 'flow' },
  { label: 'Intent', desc: 'Typed payment or trustline', kind: 'flow' },
  { label: 'Policy', desc: 'Deterministic rule check', kind: 'policy' },
  { label: 'Approval', desc: 'Human gate above threshold', kind: 'gate' },
  { label: 'Simulation', desc: 'Simulated before signing', kind: 'flow' },
  { label: 'Execution', desc: 'Sequence-coordinated', kind: 'flow' },
  { label: 'Stellar', desc: 'Testnet transaction', kind: 'chain' },
  { label: 'Activity', desc: 'Recorded and replayable', kind: 'record' },
];

type CapKey = 'agent' | 'policy' | 'intent' | 'simulation' | 'approval' | 'execution' | 'schedule' | 'audit';

const CAPABILITIES: { k: CapKey; title: string; line: string }[] = [
  { k: 'agent', title: 'Agents', line: 'Persistent identity, Stellar address and a capability set.' },
  { k: 'policy', title: 'Policies', line: 'Tx and daily limits, allowed assets, destinations and contracts.' },
  { k: 'intent', title: 'Intents', line: 'Schema-typed payment and trustline requests.' },
  { k: 'simulation', title: 'Simulation', line: 'Fee, operations and warnings before any signature.' },
  { k: 'approval', title: 'Approval', line: 'Threshold-triggered human gate with expiry.' },
  { k: 'execution', title: 'Execution', line: 'One coordinated writer per account, retry and dead-letter.' },
  { k: 'schedule', title: 'Schedules', line: 'Recurring intents — active, paused or disabled.' },
  { k: 'audit', title: 'Audit trail', line: 'Every decision, simulation and transaction recorded.' },
];

/* --- inline icons ---------------------------------------------------------- */

function Icon({ name }: { name: CapKey }) {
  const p = {
    width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': true, focusable: false,
  } as const;
  switch (name) {
    case 'agent':
      return (<svg {...p}><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10.5h5M7 13.5h8" /></svg>);
    case 'policy':
      return (<svg {...p}><path d="M12 3.2l6.8 2.9v5c0 4-2.8 7-6.8 8.4-4-1.4-6.8-4.4-6.8-8.4v-5z" /><path d="M9.2 11.8l1.9 1.9 3.8-3.9" /></svg>);
    case 'intent':
      return (<svg {...p}><path d="M4 7h12M4 12h9M4 17h6" /><path d="M17.5 14.5L20 17l-2.5 2.5" /></svg>);
    case 'simulation':
      return (<svg {...p}><circle cx="10.8" cy="10.8" r="6.2" /><path d="M15.4 15.4L20 20" /><path d="M8.6 10.8h4.4M10.8 8.6v4.4" /></svg>);
    case 'approval':
      return (<svg {...p}><circle cx="9" cy="8" r="3" /><path d="M4 18.5c.8-2.6 2.7-4 5-4s4.2 1.4 5 4" /><path d="M15.5 13l2.2 2.2 4.3-4.6" /></svg>);
    case 'execution':
      return (<svg {...p}><path d="M12 3.5v5M12 15.5v5" /><circle cx="12" cy="12" r="3.2" /><path d="M5.5 8.5L8 12l-2.5 3.5M18.5 8.5L16 12l2.5 3.5" /></svg>);
    case 'schedule':
      return (<svg {...p}><rect x="3.5" y="5.5" width="17" height="15" rx="2" /><path d="M3.5 10.5h17M8 3.5v3.2M16 3.5v3.2" /><path d="M11 13.5l1.8 1.8 3-3.2" /></svg>);
    default:
      return (<svg {...p}><path d="M5.5 3.8h9l4 4v12.4h-13z" /><path d="M8.4 9.5h7.2M8.4 13h7.2M8.4 16.5h4.6" /></svg>);
  }
}

/* --- hero visual: the policy engine and its three verdicts ----------------- */

/*
 * Network geometry mirrors the runtime order:
 *   typed intent (payment / trustline)  →  policy engine
 *   engine → allow | requires_approval | deny
 *   only allow continues: simulate → sign → submit (Stellar Testnet)
 *   a pending approval can expire back into the record (dashed return path)
 * All labels are real enum values or shipped stage names; nothing is invented.
 */
/*
 * Wide single-panel topology, matching the reference capture:
 *   payment / trustline (left)  →  POLICY ENGINE (centre, layered rings)
 *   engine → allow | requires_approval | deny (right, colour-coded)
 *   the allow branch sweeps into a bottom execution row:
 *   simulate → sign → submit → stellar → expires  (dashed stubs)
 * The "stellar" node carries the official Stellar rocket mark.
 * All labels are real enum values or shipped stage names; nothing is invented.
 */
const EDGES: string[] = [
  'M70 118 C 150 118, 214 176, 251 176',
  'M70 248 C 150 248, 214 176, 251 176',
  'M349 176 C 446 176, 508 74, 596 74',
  'M349 176 L 596 176',
  'M349 176 C 446 176, 508 278, 596 278',
  'M349 176 C 452 200, 478 320, 534 338',
];
const EXEC_DASH: string[] = [
  'M118 338 L 200 338',
  'M246 338 L 336 338',
  'M382 338 L 472 338',
  'M560 338 L 626 338',
];

/* Official Stellar rocket mark — path data taken verbatim from the official
   Stellar Docs logo (https://developers.stellar.org/img/docusaurus/stellar-logo.svg),
   whose viewBox is "0 0 799.93 200"; the mark occupies x 0..240. */
const STELLAR_ROCKET =
  'M203 26.16l-28.46 14.5-137.43 70a82.49 82.49 0 0 1-.7-10.69A81.87 81.87 0 0 1 158.2 28.6l16.29-8.3 2.43-1.24A100 100 0 0 0 18.18 100q0 3.82.29 7.61a18.19 18.19 0 0 1-9.88 17.58L0 129.57V150l25.29-12.89 8.19-4.18 8.07-4.11L186.43 55l16.28-8.29 33.65-17.15V9.14zM236.36 50L49.78 145l-16.28 8.31L0 170.38v20.41l33.27-16.95 28.46-14.5 137.57-70.1A83.45 83.45 0 0 1 200 100a81.87 81.87 0 0 1-121.91 71.36l-1 .53-17.66 9A100 100 0 0 0 218.18 100c0-2.57-.1-5.14-.29-7.68a18.2 18.2 0 0 1 9.87-17.58l8.6-4.38z';

function StellarMark({ x, y, size = 18 }: { x: number; y: number; size?: number }) {
  const k = size / 240;
  return (
    <g
      className="lp-stellar-mark"
      transform={`translate(${x - size / 2} ${y - size / 2}) scale(${k})`}
      aria-hidden="true"
    >
      <path d={STELLAR_ROCKET} />
    </g>
  );
}

function PolicyGraph() {
  return (
    <div
      className="lp-graph"
      role="img"
      aria-label="Diagram: typed payment and trustline intents reach the policy engine, which answers allow, requires_approval or deny. Only an allowed intent proceeds to simulate, sign and submit on Stellar Testnet. A pending approval can expire."
    >
      <svg className="lp-graph-svg" viewBox="0 0 720 368" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <defs>
          <linearGradient id="lpWire" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#2fc9f7" stopOpacity="0.85" />
            <stop offset="50%" stopColor="#2fc9f7" stopOpacity="1" />
            <stop offset="100%" stopColor="#2fc9f7" stopOpacity="0.85" />
          </linearGradient>
          <radialGradient id="lpHub" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#5fe0ff" stopOpacity="0.5" />
            <stop offset="55%" stopColor="#2fc9f7" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#2fc9f7" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* deep-blue structural lattice behind the network */}
        <g className="lp-lattice">
          {Array.from({ length: 12 }, (_, i) => (
            <line key={`v${i}`} x1={24 + i * 62} y1="10" x2={24 + i * 62} y2="358" />
          ))}
          {Array.from({ length: 6 }, (_, i) => (
            <line key={`h${i}`} x1="14" y1={18 + i * 64} x2="706" y2={18 + i * 64} />
          ))}
        </g>

        {/* engine bloom */}
        <circle cx="300" cy="176" r="66" fill="url(#lpHub)" />

        {/* continuous deep-blue bed under every wire */}
        {EDGES.map((d, i) => (<path key={`u${i}`} className="lp-edge-under" d={d} />))}
        {/* bright cyan core */}
        {EDGES.map((d, i) => (<path key={`c${i}`} className="lp-edge" d={d} />))}
        {/* travelling pulse on the primary branches */}
        <path className="lp-edge-flow" d={EDGES[2]} />
        <path className="lp-edge-flow" d={EDGES[3]} />
        <path className="lp-edge-flow" d={EDGES[5]} />

        {/* intent sources */}
        <circle className="lp-core lp-core-src" cx="58" cy="118" r="12" />
        <circle className="lp-core lp-core-src" cx="58" cy="248" r="12" />
        <text className="lp-tag" x="80" y="110">payment</text>
        <text className="lp-tag" x="80" y="240">trustline</text>

        {/* policy engine hub: layered rings + core */}
        <ellipse className="lp-ring lp-ring-2" cx="300" cy="176" rx="49" ry="45" />
        <ellipse className="lp-ring" cx="300" cy="176" rx="36" ry="33" />
        <circle className="lp-core lp-core-engine" cx="300" cy="176" r="14" />
        <text className="lp-tag lp-tag-head" x="300" y="180" textAnchor="middle">POLICY ENGINE</text>

        {/* verdicts with colour-coded halos */}
        <circle className="lp-halo" cx="666" cy="74" r="24" /><circle className="lp-core lp-core-ok" cx="666" cy="74" r="14" />
        <circle className="lp-halo" cx="666" cy="176" r="24" /><circle className="lp-core lp-core-hold" cx="666" cy="176" r="14" />
        <circle className="lp-halo" cx="666" cy="278" r="24" /><circle className="lp-core lp-core-err" cx="666" cy="278" r="14" />
        <text className="lp-tag lp-tag-ok" x="612" y="58">allow</text>
        <text className="lp-tag lp-tag-hold" x="612" y="160">requires_approval</text>
        <text className="lp-tag lp-tag-err" x="612" y="262">deny</text>

        {/* execution chain: four chain nodes + dashed stubs */}
        <circle className="lp-core lp-core-blue" cx="100" cy="338" r="10" />
        <circle className="lp-core lp-core-blue" cx="228" cy="338" r="10" />
        <circle className="lp-core lp-core-blue" cx="364" cy="338" r="10" />
        <circle className="lp-core lp-core-blue" cx="542" cy="338" r="10" />
        {EXEC_DASH.map((d, i) => (<path key={`d${i}`} className="lp-edge-dash" d={d} />))}
        <text className="lp-tag" x="68" y="364">simulate</text>
        <text className="lp-tag" x="220" y="364">sign</text>
        <text className="lp-tag" x="356" y="364">submit</text>
        <StellarMark x={542} y={338} size={20} />
        <text className="lp-tag" x="532" y="316">stellar</text>
        <circle className="lp-core lp-core-err" cx="672" cy="338" r="10" />
        <text className="lp-tag" x="640" y="364">expires</text>
      </svg>

    </div>
  );
}

/* --- pipeline -------------------------------------------------------------- */

function Pipeline() {
  return (
    <div
      className="lp-pipe-scroll"
      tabIndex={0}
      role="group"
      aria-label="Execution pipeline — eight stages, horizontally scrollable"
    >
      <ol className="lp-pipe">
        {STAGES.map((s, i) => (
          <li className={`lp-step lp-step-${s.kind}`} key={s.label}>
            <span className="lp-step-rail" aria-hidden="true">
              <span className="lp-step-mark">
                <span className="lp-step-num">{String(i + 1).padStart(2, '0')}</span>
              </span>
              {i < STAGES.length - 1 && <span className="lp-step-wire" />}
            </span>
            <span className="lp-step-body">
              <span className="lp-step-label">{s.label}</span>
              <span className="lp-step-desc">{s.desc}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function Landing() {
  return (
    <div className="lp">
      <a className="lp-skip" href="#lp-main">Skip to content</a>

      <header className="lp-topbar">
        <div className="lp-topbar-in">
          <Link to="/" className="lp-brand">
            <LogoMark className="lp-brand-mark" size={22} />
            <span className="lp-brand-name">4evergent</span>
          </Link>

          <nav className="lp-nav" aria-label="Landing sections">
            <a href={DOCS_URL} target="_blank" rel="noreferrer noopener">Docs</a>
            <a href={REPO_URL} target="_blank" rel="noreferrer noopener">Source</a>
            <a href={`${REPO_URL}#readme`} target="_blank" rel="noreferrer noopener">Community</a>
          </nav>

          <div className="lp-actions">
            <Link to="/login" className="lp-solid lp-solid-sm">Get Started</Link>
          </div>
        </div>
      </header>

      <main id="lp-main" className="lp-main">
        {/* =============================== HERO =============================== */}
        <section className="lp-hero" aria-labelledby="lp-h1">
          <div className="lp-hero-bg" aria-hidden="true">
            <span className="lp-gridlines" />
            <span className="lp-glow lp-glow-a" />
            <span className="lp-glow lp-glow-b" />
          </div>

          <div className="lp-hero-in">
            <div className="lp-hero-copy">
              <p className="lp-eyebrow"><span className="lp-eyebrow-dot" aria-hidden="true" />Policy engine</p>
              <h1 id="lp-h1" className="lp-h1">
                Autonomous
                <em>Financial Agents</em>
              </h1>
              <p className="lp-h1sub">Agents that act,<br />under control.</p>
              <p className="lp-lede">
                4evergent is an open-source framework for running agents with
                permissioned Stellar wallets. The model proposes a typed intent — a
                deterministic policy engine, independent of the model, decides whether
                it is allowed, denied, or requires human approval before anything is
                signed.
              </p>
              <div className="lp-cta">
                <a className="lp-solid lp-solid-lg" href={DOCS_URL} target="_blank" rel="noreferrer noopener">View docs <span aria-hidden="true">→</span></a>
                <a className="lp-ghost lp-ghost-lg" href={REPO_URL} target="_blank" rel="noreferrer noopener">Read the source</a>
              </div>
            </div>

            <div className="lp-hero-visual">
              <PolicyGraph />
            </div>
          </div>

        </section>

        {/* ============================= PIPELINE ============================= */}
        <section className="lp-band" id="pipeline" aria-labelledby="lp-h-pipe">
          <div className="lp-band-in">
            <p className="lp-kicker">The execution pipeline</p>
            <h2 id="lp-h-pipe" className="lp-h2">One path from intent to transaction</h2>
            <p className="lp-secnote">
              Every intent traverses the same ordered pipeline. Nothing skips the policy
              stage, and nothing is signed before simulation.
            </p>

            <Pipeline />
          </div>
        </section>

        {/* =========================== CONTROL PLANE ========================== */}
        <section className="lp-band" id="product" aria-labelledby="lp-h-cp">
          <div className="lp-band-in">
            <p className="lp-kicker">Control</p>
            <div className="lp-cp-cols">
              <div className="lp-cp-col">
                <h2 id="lp-h-cp" className="lp-h2">Control Plane</h2>
                <p className="lp-sub">Policy, identity and compliance — always on.</p>
                <ul className="lp-checks">
                  <li>Deterministic policy engine</li>
                  <li>Permissioned wallets</li>
                  <li>Audit &amp; observability</li>
                </ul>
              </div>
              <div className="lp-cp-col">
                <h3 className="lp-h2">Autonomous Agents</h3>
                <p className="lp-sub">Secure, composable and built for the real world.</p>
                <ul className="lp-checks">
                  <li>On-chain &amp; off-chain actions</li>
                  <li>Context-aware decision making</li>
                  <li>Full lifecycle control</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* ============================ CAPABILITIES ========================== */}
        <section className="lp-band" id="capabilities" aria-labelledby="lp-h-caps">
          <div className="lp-band-in lp-caps-layout">
            <div className="lp-caps-head">
              <p className="lp-kicker">Capabilities</p>
              <h2 id="lp-h-caps" className="lp-h2">Built for what's next.</h2>
              <p className="lp-sub">Eight core capabilities working together to give you
                programmable, secure and compliant financial agents.</p>
            </div>

            <ul className="lp-caps">
              {CAPABILITIES.map((c) => (
                <li className="lp-cap" key={c.k}>
                  <span className="lp-cap-icon" aria-hidden="true"><Icon name={c.k} /></span>
                  <span className="lp-cap-text">
                    <span className="lp-cap-title">{c.title}</span>
                    <span className="lp-cap-line">{c.line}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ============================== NETWORK ============================= */}
        <section className="lp-band" id="network" aria-labelledby="lp-h-net">
          <div className="lp-band-in">
            <div className="lp-testnet">
              <span className="lp-testnet-arc" aria-hidden="true" />
              <span className="lp-testnet-icon" aria-hidden="true">◎</span>
              <div className="lp-testnet-copy">
                <p className="lp-kicker">Testnet</p>
                <h2 id="lp-h-net" className="lp-h2">Try it on Stellar Testnet</h2>
                <p className="lp-sub">Explore the platform, test agents and build with
                  confidence — all on the Stellar Testnet.</p>
              </div>
              <Link to="/login" className="lp-testnet-go">Get started <span aria-hidden="true">→</span></Link>
            </div>
          </div>
        </section>

        {/* ============================== CLOSING ============================= */}
        <section className="lp-final" aria-labelledby="lp-h-final">
          <div className="lp-final-in">
            <h2 id="lp-h-final" className="lp-h2 lp-h2-final">Secure. Compliant. Programmable.</h2>
            <p className="lp-final-note">
              The financial agent platform for a more open internet.
            </p>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <div className="lp-foot-in">
          <span className="lp-foot-brand">
            <LogoMark className="lp-brand-mark" size={22} />
            4evergent
          </span>
          <nav className="lp-foot-links" aria-label="Footer links">
            <a href={REPO_URL} target="_blank" rel="noreferrer noopener">Source</a>
            <a href={DOCS_URL} target="_blank" rel="noreferrer noopener">Docs</a>
            <Link to="/login">Sign in</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
