/**
 * The Buta demo video.
 *
 * Two kinds of frame, cut against one timeline:
 *
 *   - Slides, drawn in code, in the same Swiss-industrial language as the deck.
 *   - Real footage of the deployed desk, recorded by video/capture.mjs against
 *     the live enclave. Nothing is mocked up: the book in those clips came from
 *     the machine on the tunnel and the countdown from the chain's head.
 *
 * The voice track is deliberately absent. Flare disqualifies AI voice, so
 * public/vo.wav is a slot for a recording in your own voice; when it is there
 * the composition plays it, and when it is not the video renders silent and
 * still reads, because every word is also on screen as a subtitle.
 */
import React from "react";
import {
  AbsoluteFill,
  Audio,
  Easing,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { BEATS, FPS, TIMELINE, type Beat } from "./script";
import MARKS from "./marks.json";

const PAPER = "#F4F4F0";
const PAPER_1 = "#EFEEE9";
const INK = "#0A0A0A";
const INK_DIM = "#3B3B38";
const INK_MUTE = "#6E6E68";
const RED = "#CE1414";
const LINE = "#C9C7BF";

const UI = "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, system-ui, sans-serif";
const MONO = "JetBrains Mono, Cascadia Mono, Consolas, ui-monospace, monospace";
const MACRO = "Archivo Black, Arial Black, Haettenschweiler, Impact, sans-serif";

/** Everything enters the same way, so cuts feel like one hand moving. */
const useRise = (delay = 0) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 200, mass: 0.6 } });
  return { opacity: s, transform: `translateY(${interpolate(s, [0, 1], [22, 0])}px)` };
};

const Eyebrow: React.FC<{ children: React.ReactNode; delay?: number }> = ({ children, delay = 0 }) => (
  <div
    style={{
      ...useRise(delay),
      fontFamily: UI,
      fontSize: 22,
      letterSpacing: "0.2em",
      textTransform: "uppercase",
      fontWeight: 700,
      color: RED,
    }}
  >
    {children}
  </div>
);

const Title: React.FC<{ children: React.ReactNode; delay?: number; size?: number }> = ({
  children,
  delay = 6,
  size = 92,
}) => (
  <h1
    style={{
      ...useRise(delay),
      fontFamily: MACRO,
      fontSize: size,
      lineHeight: 1.03,
      margin: "18px 0 26px",
      maxWidth: "20ch",
      color: INK,
    }}
  >
    {children}
  </h1>
);

const Body: React.FC<{ children: React.ReactNode; delay?: number }> = ({ children, delay = 12 }) => (
  <p
    style={{
      ...useRise(delay),
      fontFamily: UI,
      fontSize: 34,
      lineHeight: 1.45,
      color: INK_DIM,
      maxWidth: "44ch",
      margin: 0,
    }}
  >
    {children}
  </p>
);

/** The slide substrate: paper, a hairline grid, one red rule. */
const Slide: React.FC<{ children?: React.ReactNode; alt?: boolean }> = ({ children, alt }) => (
  <AbsoluteFill style={{ backgroundColor: alt ? PAPER_1 : PAPER, padding: "96px 110px 190px" }}>
    <AbsoluteFill
      style={{
        backgroundImage: `linear-gradient(${LINE} 1px, transparent 1px), linear-gradient(90deg, ${LINE} 1px, transparent 1px)`,
        backgroundSize: "120px 120px",
        opacity: 0.28,
      }}
    />
    <div style={{ position: "absolute", left: 0, top: 0, width: 8, height: "100%", backgroundColor: RED }} />
    <AbsoluteFill style={{ padding: "96px 110px 190px", justifyContent: "center" }}>{children}</AbsoluteFill>
  </AbsoluteFill>
);

const Card: React.FC<{ head: string; children: React.ReactNode; delay: number }> = ({ head, children, delay }) => (
  <div
    style={{
      ...useRise(delay),
      border: `1px solid ${LINE}`,
      backgroundColor: PAPER,
      padding: "22px 24px",
      flex: 1,
    }}
  >
    <div style={{ fontFamily: UI, fontSize: 28, fontWeight: 700, marginBottom: 10, color: INK }}>{head}</div>
    <div style={{ fontFamily: UI, fontSize: 25, lineHeight: 1.4, color: INK_DIM }}>{children}</div>
  </div>
);

/**
 * A recorded clip, framed like a screen rather than pasted edge to edge.
 *
 * OffthreadVideo, not Video: the renderer extracts exact frames instead of
 * asking a browser to play in real time, which is what stops a screen capture
 * from drifting against the words describing it.
 */
/** The viewport the clips were recorded at. Marks are in this space. */
const SHOT = { w: 1440, h: 900 };

type Mark = { x: number; y: number; width: number; height: number };
const marks = (MARKS as { marks: Record<string, Mark> }).marks;
/** Seconds of loading to skip at the head of each clip. See capture.mjs. */
const starts = (MARKS as { starts: Record<string, number> }).starts;
/** Seconds into the live recording where each step actually happened. */
const live = ((MARKS as { live?: Record<string, number> }).live ?? {}) as Record<string, number>;

/** A mark as percentages, so it survives whatever size the clip is drawn at. */
const asPercent = (m: Mark) => ({
  left: `${(m.x / SHOT.w) * 100}%`,
  top: `${(m.y / SHOT.h) * 100}%`,
  width: `${(m.width / SHOT.w) * 100}%`,
  height: `${(m.height / SHOT.h) * 100}%`,
});

/**
 * A box drawn around the thing being talked about.
 *
 * The coordinates are measured during the recording rather than written here:
 * hardcoding them would be a second copy of the desk's layout, wrong the first
 * time a column moves. capture.mjs writes src/marks.json while it has the real
 * page open.
 *
 * Boxes appear in the second half of a shot on purpose. The page is still
 * scrolling early on, and a box pinned to a rectangle the page has moved past
 * points at nothing.
 */
const Box: React.FC<{ mark: string; label: string; delay: number; above?: boolean }> = ({
  mark,
  label,
  delay,
  above,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const m = marks[mark];
  if (!m || m.y < 0) return null;
  const s = spring({ frame: frame - delay, fps, config: { damping: 200, mass: 0.5 } });
  if (s < 0.01) return null;
  const box = asPercent(m);
  const rightHalf = (m.x + m.width / 2) / SHOT.w > 0.55;
  return (
    <div style={{ position: "absolute", ...box, opacity: s }}>
      <div
        style={{
          position: "absolute",
          inset: -6,
          border: `3px solid ${RED}`,
          boxShadow: `0 0 0 9999px rgba(10,10,10,${0.34 * s})`,
          transform: `scale(${interpolate(s, [0, 1], [1.08, 1])})`,
        }}
      />
      {/* The label hangs off whichever side has room. Anchored left it ran
          off the frame for anything in the right half of the page, which is
          where the reserve column and the deadline both live. */}
      <div
        style={{
          position: "absolute",
          ...(rightHalf ? { right: 0 } : { left: 0 }),
          ...(above ? { bottom: "100%", marginBottom: 12 } : { top: "100%", marginTop: 12 }),
          backgroundColor: RED,
          color: "#fff",
          fontFamily: UI,
          fontSize: 24,
          fontWeight: 600,
          padding: "8px 14px",
          whiteSpace: "nowrap",
          transform: `translateY(${interpolate(s, [0, 1], [above ? 8 : -8, 0])}px)`,
        }}
      >
        {label}
      </div>
    </div>
  );
};

const Clip: React.FC<{
  src: string;
  caption?: string;
  /** Zoom in on this mark, so a detail is legible at a glance. */
  focus?: string;
  boxes?: { mark: string; label: string; delay: number; above?: boolean }[];
  /** Seconds into the file to start at, when one recording feeds several beats. */
  startAt?: number;
}> = ({ src, caption, focus, boxes, startAt }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 200, mass: 0.7 } });
  const scale = interpolate(s, [0, 1], [1.04, 1]);

  // The zoom holds off until the shot has established itself, then eases in and
  // stays. A push that starts on the cut reads as a mistake rather than as
  // attention being directed.
  const fm = focus ? marks[focus] : undefined;
  const zoomStart = Math.round(durationInFrames * 0.34);
  const z = fm
    ? interpolate(frame, [zoomStart, zoomStart + 26], [1, 1.26], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.inOut(Easing.quad),
      })
    : 1;
  const origin = fm
    ? `${((fm.x + fm.width / 2) / SHOT.w) * 100}% ${((fm.y + fm.height / 2) / SHOT.h) * 100}%`
    : "50% 50%";
  return (
    <AbsoluteFill style={{ backgroundColor: INK, justifyContent: "center", alignItems: "center" }}>
      <div
        style={{
          width: 1640,
          transform: `scale(${scale})`,
          opacity: s,
          border: `1px solid #2A2A28`,
          boxShadow: "0 40px 120px rgba(0,0,0,.55)",
          backgroundColor: PAPER,
        }}
      >
        {/* A window bar, so a full-bleed screenshot reads as a browser. */}
        <div
          style={{
            height: 44,
            backgroundColor: "#E2E0DA",
            borderBottom: `1px solid ${LINE}`,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "0 16px",
          }}
        >
          <span style={{ width: 12, height: 12, borderRadius: 12, backgroundColor: "#C9C7BF" }} />
          <span style={{ width: 12, height: 12, borderRadius: 12, backgroundColor: "#C9C7BF" }} />
          <span style={{ width: 12, height: 12, borderRadius: 12, backgroundColor: RED }} />
          <span style={{ marginLeft: 18, fontFamily: MONO, fontSize: 20, color: INK_MUTE }}>
            buta-desk.vercel.app/dashboard
          </span>
        </div>
        <div style={{ position: "relative", overflow: "hidden" }}>
          <div style={{ transform: `scale(${z})`, transformOrigin: origin }}>
            {/* startFrom skips the loading. Every recording opens on a blank
                page and several seconds of waiting for the enclave, and a beat
                playing from frame zero was that and nothing else. */}
            <OffthreadVideo
              src={staticFile(`clips/${src}`)}
              startFrom={Math.round((startAt ?? starts[src.replace(".webm", "")] ?? 0) * FPS)}
              style={{ width: "100%", display: "block" }}
              muted
            />
            {(boxes ?? []).map((b) => (
              <Box key={b.mark} mark={b.mark} label={b.label} delay={b.delay} above={b.above} />
            ))}
          </div>
        </div>
      </div>
      {caption ? (
        <div
          style={{
            position: "absolute",
            top: 54,
            left: 0,
            right: 0,
            textAlign: "center",
            fontFamily: UI,
            fontSize: 26,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: "#EFEEE9",
            opacity: 0.85,
          }}
        >
          {caption}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

const Scene: React.FC<{ beat: Beat }> = ({ beat }) => {
  switch (beat.scene) {
    case "title":
      return (
        <Slide>
          <Eyebrow>Flare Summer Signal / Confidential Compute</Eyebrow>
          <Title size={112}>
            Sealed bids, cleared by an enclave that forgets them.
          </Title>
          <Body>A sealed-bid OTC desk on Flare Confidential Compute.</Body>
        </Slide>
      );

    case "problem":
      return (
        <Slide alt>
          <Eyebrow>01 / the problem</Eyebrow>
          <Title>Finding a price for size means showing the size</Title>
          <Body>
            Show a block to five counterparties, and one of them trades ahead of you. So the trade
            stays in chat rooms: un-auditable, and resting on trusting whoever holds the spread.
          </Body>
        </Slide>
      );

    case "fails":
      return (
        <Slide>
          <Eyebrow>02 / why the obvious fixes fail</Eyebrow>
          <Title>A public contract cannot read a sealed bid</Title>
          <div style={{ display: "flex", gap: 28, marginTop: 14 }}>
            <Card head="Put the book on chain" delay={14}>
              To know every bid on chain is to publish every bid.
            </Card>
            <Card head="Commit and reveal" delay={22}>
              A loser who never reveals stalls the clearing, and revealing publishes your size.
            </Card>
          </div>
        </Slide>
      );

    case "what":
      return (
        <Slide alt>
          <Eyebrow>03 / what it is</Eyebrow>
          <Title>The auctioneer is blind</Title>
          <Body>
            Bids are encrypted to an attested enclave. It opens them, clears at the Vickrey second
            price, and returns only the winner and that price.
          </Body>
        </Slide>
      );

    case "flow":
      return (
        <Slide>
          <Eyebrow>04 / how it works</Eyebrow>
          <Title size={72}>Four steps, and only one of them trusts the enclave</Title>
          <div style={{ display: "flex", gap: 20, marginTop: 10 }}>
            <Card head="1. Post" delay={12}>
              The lot is escrowed. The floor is sealed to the enclave.
            </Card>
            <Card head="2. Seal" delay={18}>
              A 32-byte commitment on chain, plus a ciphertext only the enclave opens.
            </Card>
            <Card head="3. Clear" delay={24}>
              After the deadline block, the enclave ranks and signs.
            </Card>
            <Card head="4. Settle" delay={30}>
              The contract checks the signature and the set, then moves both legs.
            </Card>
          </div>
        </Slide>
      );

    case "clip-arrive":
      return <Clip src="arrive.webm" caption="the deployed desk, live" />;
    case "clip-book":
      return (
        <Clip
          src="book.webm"
          caption="lot and deadline public, reserve sealed"
          focus="firstRow"
          boxes={[
            { mark: "reserveBar", label: "the maker's floor, sealed", delay: 150 },
            { mark: "deadline", label: "deadline block, public", delay: 200, above: true },
          ]}
        />
      );
    // Three beats cut out of one real run, at the seconds it actually happened.
    case "clip-post":
      return (
        <Clip
          src="live.webm"
          caption="posting a block, for real"
          // Start 13s before the receipt, so the beat runs from typing through
          // the signature to the row appearing in the book.
          startAt={Math.max(0, (live.posted ?? 27) - 13)}
        />
      );
    case "clip-seal":
      return (
        <Clip
          src="live-bid.webm"
          caption="a second wallet seals a bid"
          startAt={20}
        />
      );
    case "clip-settle":
      return (
        <Clip
          src="live.webm"
          caption="the enclave signs, the contract settles"
          startAt={Math.max(0, (live.cleared ?? 200) - 8)}
        />
      );
    case "clip-audit":
      return (
        <Clip
          src="audit.webm"
          caption="every line a public read"
          focus="auditRows"
          boxes={[{ mark: "auditRows", label: "read from the chain by your browser", delay: 130, above: true }]}
        />
      );

    case "trim":
      return (
        <Slide>
          <Eyebrow>05 / the hard part</Eyebrow>
          <Title size={78}>The bid set cannot be trimmed</Title>
          <div style={{ ...useRise(14), borderLeft: `6px solid ${RED}`, paddingLeft: 26, maxWidth: "48ch" }}>
            <p style={{ fontFamily: UI, fontSize: 36, lineHeight: 1.4, color: INK, margin: 0 }}>
              The enclave signs over the commitments <b>the contract recorded</b>, not the ones it
              was handed.
            </p>
          </div>
          <div
            style={{
              ...useRise(26),
              fontFamily: MONO,
              fontSize: 26,
              color: INK_DIM,
              marginTop: 30,
              backgroundColor: PAPER_1,
              border: `1px solid ${LINE}`,
              padding: "18px 22px",
              maxWidth: "60ch",
            }}
          >
            if (setDigest != commitmentDigest(rfqId)) revert SetDigestMismatch();
          </div>
        </Slide>
      );

    case "solvency":
      return (
        <Slide alt>
          <Eyebrow>06 / the second hard part</Eyebrow>
          <Title size={78}>Solvency, without disclosure</Title>
          <Body>
            A bidder who cannot pay the price they would owe is passed over, and nobody is told what
            they bid. The only party that can read the bids is the one party that never repeats them.
          </Body>
        </Slide>
      );

    case "proof":
      return (
        <Slide>
          <Eyebrow>07 / proof</Eyebrow>
          <Title size={78}>It settles on Coston2</Title>
          <div style={{ ...useRise(12), fontFamily: MONO, fontSize: 27, color: INK_DIM, lineHeight: 2.0 }}>
            <div>
              <span style={{ color: INK }}>contract</span> 0xa03821AD&hellip;F74D, extension 66009
            </div>
            <div>
              <span style={{ color: INK }}>settled</span> 0x5a5f867f&hellip; delivery versus payment
            </div>
            <div>
              <span style={{ color: INK }}>rotated</span> 0x0783b99b&hellip; new enclave, same desk
            </div>
            <div>
              <span style={{ color: INK }}>settled</span> 0x5ca111a5&hellip; after the rotation
            </div>
            <div>
              <span style={{ color: INK }}>settled</span> 0x55b07ad0&hellip; from this desk, not a script
            </div>
          </div>
        </Slide>
      );

    case "honest":
      return (
        <Slide alt>
          <Eyebrow>08 / what is not done</Eyebrow>
          <Title size={72}>Said plainly, because you would find it anyway</Title>
          <Body>
            Flare's simulated TEE path, so the key sits in the process rather than in hardware. A
            container behind a reserved tunnel, not hosted infrastructure. Testnet tokens. Not
            audited.
          </Body>
        </Slide>
      );

    case "close":
      return (
        <Slide>
          <Eyebrow>Buta</Eyebrow>
          <Title size={84}>Every sealed-bid venue leaves one reader standing.</Title>
          <Body>
            Buta makes that reader an attested enclave that is not a party to the trade, cannot be
            handed a doctored bid set, and keeps nothing.
          </Body>
          <div style={{ ...useRise(26), fontFamily: MONO, fontSize: 28, color: RED, marginTop: 26 }}>
            buta-desk.vercel.app/dashboard
          </div>
        </Slide>
      );

    default:
      return <Slide />;
  }
};

/**
 * Subtitles, from the same array that cuts the picture.
 *
 * Burned in rather than a sidecar file: this is watched once, in a browser tab,
 * by somebody who may well have the sound off.
 */
const Subtitle: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const inOp = interpolate(frame, [0, 8], [0, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.quad) });
  const outOp = interpolate(frame, [durationInFrames - 8, durationInFrames], [1, 0], {
    extrapolateLeft: "clamp",
  });
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 62 }}>
      <div
        style={{
          opacity: Math.min(inOp, outOp),
          maxWidth: 1500,
          backgroundColor: "rgba(10,10,10,.88)",
          color: "#F4F4F0",
          fontFamily: UI,
          fontSize: 36,
          lineHeight: 1.35,
          padding: "20px 30px",
          textAlign: "center",
          borderLeft: `6px solid ${RED}`,
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

/** A thin red progress rule, so a viewer knows how much is left. */
const Progress: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  return (
    <AbsoluteFill style={{ justifyContent: "flex-start" }}>
      <div style={{ height: 6, width: `${(frame / durationInFrames) * 100}%`, backgroundColor: RED }} />
    </AbsoluteFill>
  );
};

export const Demo: React.FC<{ withVoice?: boolean }> = ({ withVoice = false }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: PAPER }}>
      {TIMELINE.map(({ beat, from, durationInFrames }, i) => (
        <Sequence key={i} from={from} durationInFrames={durationInFrames}>
          <Scene beat={beat} />
          <Subtitle text={beat.say} />
        </Sequence>
      ))}
      <Progress />
      {/* Drop a recording of your own voice at public/vo.wav and set withVoice. */}
      {withVoice ? <Audio src={staticFile("vo.wav")} /> : null}
    </AbsoluteFill>
  );
};

export { BEATS, FPS };
