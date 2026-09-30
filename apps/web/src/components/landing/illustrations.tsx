// Hand-drawn line-art illustrations for the landing page.
// Every drawing is inline SVG with `stroke="currentColor"`, so it follows the text colour
// (and therefore dark mode). A tiny turbulence filter gives the lines a slightly wobbly,
// pen-on-paper feel. Flat fills only use the `--lp-*` tint tokens from landing.css.
import { useId, type ReactNode } from "react";

type SketchProps = {
  viewBox: string;
  className?: string;
  children: ReactNode;
  /** Displacement strength of the wobble filter (0 disables it). */
  wobble?: number;
  strokeWidth?: number;
};

/** Shared SVG shell: decorative, currentColor strokes, round caps, sketchy wobble. */
function Sketch({ viewBox, className, children, wobble = 2.2, strokeWidth = 1.5 }: SketchProps) {
  const id = `lp-rough-${useId().replace(/:/g, "")}`;
  return (
    <svg
      viewBox={viewBox}
      className={className}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {wobble > 0 && (
        <defs>
          <filter id={id} x="-5%" y="-5%" width="110%" height="110%">
            <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="7" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale={wobble} xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>
      )}
      <g filter={wobble > 0 ? `url(#${id})` : undefined}>{children}</g>
    </svg>
  );
}

/** Small text glyph drawn with the fill colour (strokes are for lines only). */
function Glyph({ x, y, size, children, rotate = 0, family = "var(--lp-display)" }: { x: number; y: number; size: number; children: string; rotate?: number; family?: string }) {
  return (
    <text
      x={x}
      y={y}
      fontSize={size}
      fill="currentColor"
      stroke="none"
      fontFamily={family}
      textAnchor="middle"
      transform={rotate ? `rotate(${rotate} ${x} ${y})` : undefined}
    >
      {children}
    </text>
  );
}

function Sparkle({ x, y, r = 7 }: { x: number; y: number; r?: number }) {
  return <path d={`M${x} ${y - r}v${2 * r}M${x - r} ${y}h${2 * r}M${x - r * 0.45} ${y - r * 0.45}l${r * 0.9} ${r * 0.9}M${x + r * 0.45} ${y - r * 0.45}l${-r * 0.9} ${r * 0.9}`} strokeWidth={1.1} />;
}

function Note({ x, y, s = 1 }: { x: number; y: number; s?: number }) {
  // An eighth note: head, stem and a curly flag.
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <ellipse cx="0" cy="0" rx="6.5" ry="4.6" transform="rotate(-22)" />
      <path d="M6 -1.5 V-30 C 11 -24, 18 -22, 16 -12" />
    </g>
  );
}

/* ------------------------------------------------------------------ */
/* Hero: an open book whose page has been folded into a paper plane.  */
/* ------------------------------------------------------------------ */
export function HeroIllustration({ className }: { className?: string }) {
  return (
    <Sketch viewBox="0 0 600 430" className={className}>
      {/* pastel blobs behind */}
      <path d="M170 250 C 150 150, 260 70, 370 92 C 480 112, 520 210, 470 280 C 420 350, 250 360, 196 318 C 180 305, 173 280, 170 250 Z" fill="var(--lp-mist-strong)" stroke="none" />
      <circle cx="470" cy="118" r="58" fill="var(--lp-honey-soft)" stroke="none" />

      {/* shadow + hatching under the book */}
      <path d="M110 398 C 200 410, 400 410, 492 398" />
      {Array.from({ length: 14 }, (_, i) => (
        <path key={i} d={`M${150 + i * 22} 406 l12 -9`} strokeWidth={1.1} />
      ))}

      {/* open book */}
      <path d="M300 312 C 258 292, 190 290, 124 302 L 112 382 C 178 370, 250 372, 300 394 Z" fill="var(--lp-paper)" />
      <path d="M300 312 C 342 292, 410 290, 476 302 L 488 382 C 422 370, 350 372, 300 394 Z" fill="var(--lp-paper)" />
      <path d="M300 312 V394" />
      <path d="M112 382 L 106 392 C 176 380, 250 382, 300 404 C 350 382, 424 380, 494 392 L 488 382" />
      {/* lines of text on the left page */}
      {[0, 1, 2, 3, 4].map((i) => (
        <path key={`l${i}`} d={`M${140 - i * 2} ${316 + i * 12} C ${190} ${306 + i * 12}, ${240} ${308 + i * 12}, ${284} ${322 + i * 12}`} strokeWidth={1.1} />
      ))}
      {/* right page: a torn corner where the plane came from, and a few lines */}
      <path d="M404 296 L 418 314 L 440 306 L 452 322 L 476 318" strokeDasharray="3 4" />
      {[0, 1, 2, 3].map((i) => (
        <path key={`r${i}`} d={`M316 ${334 + i * 12} C 350 ${322 + i * 12}, 400 ${320 + i * 12}, ${456 + i * 2} ${328 + i * 12}`} strokeWidth={1.1} />
      ))}
      {/* bookmark ribbon */}
      <path d="M268 300 V 346 L 276 338 L 284 346 V 303" fill="var(--lp-clay)" />

      {/* dotted flight path from the page to the plane */}
      <path d="M430 300 C 470 250, 360 250, 330 220 C 300 190, 340 160, 372 168" strokeDasharray="2 7" />

      {/* the paper plane (folded from a printed page) */}
      <g>
        <path d="M512 70 L 350 124 L 420 140 Z" fill="var(--lp-paper)" />
        <path d="M512 70 L 420 140 L 404 182 L 434 150 Z" fill="var(--lp-paper)" />
        <path d="M420 140 L 434 150" />
        {/* print on the wing */}
        <path d="M384 122 L 460 100" strokeWidth={1} />
        <path d="M398 128 L 470 106" strokeWidth={1} />
        <path d="M414 132 L 478 112" strokeWidth={1} />
      </g>
      {/* speed lines */}
      <path d="M332 92 L 262 108" />
      <path d="M340 112 L 244 134" />
      <path d="M350 140 L 290 154" />
      <path d="M318 76 L 290 82" />

      {/* letters drifting off the page */}
      <Glyph x={214} y={232} size={34} rotate={-12}>言</Glyph>
      <Glyph x={262} y={176} size={28} rotate={8}>あ</Glyph>
      <Glyph x={170} y={180} size={30} rotate={-6} family="var(--lp-italic)">a</Glyph>
      <Glyph x={520} y={236} size={26} rotate={10}>♪</Glyph>

      <Sparkle x={130} y={120} r={8} />
      <Sparkle x={560} y={170} r={6} />
      <Sparkle x={300} y={60} r={5} />
    </Sketch>
  );
}

/* ------------------------------------------------------------------ */
/* Band: vintage headphones beside a sheet of timed lyrics.           */
/* ------------------------------------------------------------------ */
export function HeadphonesIllustration({ className }: { className?: string }) {
  return (
    <Sketch viewBox="0 0 560 280" className={className}>
      <path d="M40 262 C 200 270, 380 270, 530 260" />
      {Array.from({ length: 10 }, (_, i) => (
        <path key={i} d={`M${70 + i * 44} 272 l10 -7`} strokeWidth={1} />
      ))}

      {/* headphones */}
      <path d="M96 176 C 92 70, 250 54, 262 170" strokeWidth={2.2} />
      <path d="M106 176 C 104 88, 242 76, 252 170" />
      <rect x="72" y="160" width="46" height="84" rx="20" fill="var(--lp-paper)" />
      <rect x="240" y="156" width="46" height="84" rx="20" fill="var(--lp-paper)" />
      <path d="M84 176 C 80 196, 80 212, 84 230" strokeWidth={1.1} />
      <path d="M274 172 C 278 192, 278 208, 274 226" strokeWidth={1.1} />
      {[0, 1, 2, 3].map((i) => (
        <path key={i} d={`M${96 + i * 5} 168 l -8 ${10 + i}`} strokeWidth={0.9} />
      ))}
      {/* coiled cable to the lyric sheet */}
      <path d="M268 240 C 280 262, 300 250, 300 236 C 300 222, 318 222, 318 238 C 318 254, 338 252, 338 236 C 338 222, 356 222, 360 240" />

      {/* lyric sheet, slightly tilted */}
      <g transform="rotate(5 450 140)">
        <rect x="370" y="30" width="160" height="210" rx="4" fill="var(--lp-paper)" />
        <path d="M370 44 L 530 44" strokeWidth={1} />
        <rect x="382" y="120" width="136" height="20" rx="3" fill="var(--lp-honey-soft)" stroke="none" />
        {["[00:08]", "[00:12]", "[00:16]", "[00:21]", "[00:25]", "[00:30]"].map((ts, i) => (
          <g key={ts}>
            <text x="386" y={70 + i * 28} fontSize="10" fill="currentColor" stroke="none" fontFamily="ui-monospace, Menlo, monospace">{ts}</text>
            <path d={`M428 ${66 + i * 28} C 450 ${62 + i * 28}, 480 ${68 + i * 28}, ${510 - (i % 3) * 12} ${64 + i * 28}`} strokeWidth={i === 2 ? 2 : 1.1} />
          </g>
        ))}
      </g>

      <Note x={200} y={70} s={1.1} />
      <Note x={320} y={96} s={0.9} />
      <Note x={350} y={40} s={0.8} />
      <Sparkle x={40} y={110} r={7} />
      <Sparkle x={300} y={30} r={5} />
    </Sketch>
  );
}

/* ------------------------------------------------------------------ */
/* Feature cards (ink on quiet tints)                                 */
/* ------------------------------------------------------------------ */
export function FlashcardsIllustration({ className }: { className?: string }) {
  return (
    <Sketch viewBox="0 0 220 160" className={className}>
      <g transform="rotate(-9 90 80)">
        <rect x="36" y="30" width="116" height="84" rx="6" fill="var(--lp-paper)" />
        {[0, 1, 2].map((i) => <path key={i} d={`M50 ${52 + i * 14} H ${128 - i * 18}`} strokeWidth={1} />)}
      </g>
      <g transform="rotate(5 130 90)">
        <rect x="72" y="44" width="120" height="86" rx="6" fill="var(--lp-paper)" />
        <Glyph x={132} y={94} size={26}>言葉</Glyph>
        <path d="M110 104 H 154" strokeWidth={1} strokeDasharray="2 4" />
        {[0, 1, 2, 3].map((i) => (
          <rect key={i} x={84 + i * 25} y="112" width="20" height="10" rx="5" strokeWidth={1} />
        ))}
      </g>
      {/* little flip arrow */}
      <path d="M26 118 C 18 96, 26 76, 44 68" />
      <path d="M38 64 L 45 68 L 40 75" />
      <Sparkle x={196} y={30} r={7} />
      <path d="M190 146 l8 -6 M180 148 l8 -6 M200 144 l8 -6" strokeWidth={1} />
    </Sketch>
  );
}

export function OpenBookIllustration({ className }: { className?: string }) {
  return (
    <Sketch viewBox="0 0 220 160" className={className}>
      <path d="M110 44 C 86 32, 50 30, 22 38 L 20 122 C 50 114, 86 116, 110 130 Z" fill="var(--lp-paper)" />
      <path d="M110 44 C 134 32, 170 30, 198 38 L 200 122 C 170 114, 134 116, 110 130 Z" fill="var(--lp-paper)" />
      <path d="M110 44 V 130" />
      <path d="M20 122 L 16 130 C 50 122, 86 124, 110 138 C 134 124, 170 122, 204 130 L 200 122" />
      {[0, 1, 2, 3, 4].map((i) => (
        <path key={`a${i}`} d={`M32 ${54 + i * 13} C 60 ${48 + i * 13}, 86 ${50 + i * 13}, 100 ${58 + i * 13}`} strokeWidth={1} />
      ))}
      {[0, 1, 2, 3, 4].map((i) => (
        <path key={`b${i}`} d={`M120 ${58 + i * 13} C 136 ${50 + i * 13}, 162 ${48 + i * 13}, 188 ${54 + i * 13}`} strokeWidth={1} strokeDasharray={i % 2 ? "3 4" : undefined} />
      ))}
      {/* a word lifted out with its translation */}
      <rect x="120" y="10" width="72" height="24" rx="12" fill="var(--lp-paper)" />
      <Glyph x={156} y={27} size={13}>あ → A</Glyph>
      <path d="M150 34 L 146 48" strokeDasharray="2 3" />
      <path d="M86 28 V 64 L 92 58 L 98 64 V 30" fill="var(--lp-honey-soft)" />
    </Sketch>
  );
}

export function MicrophoneIllustration({ className }: { className?: string }) {
  return (
    <Sketch viewBox="0 0 220 160" className={className}>
      {/* staff lines */}
      {[0, 1, 2, 3, 4].map((i) => (
        <path key={i} d={`M10 ${58 + i * 9} C 60 ${50 + i * 9}, 120 ${66 + i * 9}, 212 ${54 + i * 9}`} strokeWidth={0.9} />
      ))}
      <Note x={40} y={82} s={0.9} />
      <Note x={82} y={74} s={0.9} />
      <Note x={176} y={70} s={0.9} />
      {/* vintage microphone */}
      <rect x="112" y="28" width="40" height="62" rx="20" fill="var(--lp-paper)" />
      {[0, 1, 2, 3].map((i) => <path key={i} d={`M114 ${46 + i * 10} H 150`} strokeWidth={1} />)}
      <path d="M104 70 C 104 100, 160 100, 160 70" />
      <path d="M132 96 V 130" />
      <path d="M112 132 H 152" />
      <path d="M118 138 H 146" strokeWidth={1} />
      <Sparkle x={196} y={22} r={6} />
      <Sparkle x={24} y={26} r={5} />
    </Sketch>
  );
}

export function DevicesIllustration({ className }: { className?: string }) {
  return (
    <Sketch viewBox="0 0 220 160" className={className}>
      {/* laptop with a terminal prompt */}
      <rect x="24" y="36" width="118" height="74" rx="5" fill="var(--lp-paper)" />
      <path d="M12 118 H 154 L 146 110 H 20 Z" fill="var(--lp-paper)" />
      <Glyph x={50} y={62} size={12} family="ui-monospace, Menlo, monospace">$ koto</Glyph>
      <path d="M36 74 H 96 M36 84 H 118 M36 94 H 76" strokeWidth={1} />
      <rect x="80" y="88" width="7" height="10" fill="currentColor" stroke="none" />
      {/* phone */}
      <rect x="160" y="54" width="44" height="80" rx="8" fill="var(--lp-paper)" />
      <path d="M176 60 H 188" />
      <Glyph x={182} y={96} size={15}>語</Glyph>
      <path d="M170 110 H 194 M170 118 H 188" strokeWidth={1} />
      {/* sync arrows */}
      <path d="M130 26 C 150 12, 176 16, 186 40" />
      <path d="M180 36 L 186 42 L 191 34" />
      <path d="M190 146 C 170 156, 140 154, 128 136" />
      <path d="M134 138 L 127 134 L 124 142" />
    </Sketch>
  );
}

/* ------------------------------------------------------------------ */
/* Thumbnails for the updates/docs cards                              */
/* ------------------------------------------------------------------ */
export function NewspaperThumb({ className }: { className?: string }) {
  return (
    <Sketch viewBox="0 0 160 100" className={className}>
      <rect x="36" y="16" width="88" height="70" rx="3" fill="var(--lp-paper)" />
      <path d="M46 28 H 114" strokeWidth={2.4} />
      <rect x="46" y="38" width="30" height="24" strokeWidth={1} />
      <path d="M50 58 L 58 48 L 64 54 L 68 50 L 74 58" strokeWidth={1} />
      <path d="M84 40 H 114 M84 48 H 112 M84 56 H 106 M46 70 H 114 M46 78 H 96" strokeWidth={1} />
      <Sparkle x={134} y={20} r={6} />
      <Sparkle x={24} y={74} r={4} />
    </Sketch>
  );
}

export function GuideThumb({ className }: { className?: string }) {
  return (
    <Sketch viewBox="0 0 160 100" className={className}>
      <path d="M80 26 C 66 18, 44 18, 30 24 V 84 C 44 78, 66 78, 80 86 Z" fill="var(--lp-paper)" />
      <path d="M80 26 C 94 18, 116 18, 130 24 V 84 C 116 78, 94 78, 80 86 Z" fill="var(--lp-paper)" />
      <path d="M80 26 V 86" />
      <path d="M38 36 H 70 M38 46 H 66 M38 56 H 72" strokeWidth={1} />
      {/* a key: bring your own AI key */}
      <circle cx="104" cy="50" r="9" />
      <path d="M104 59 V 76 M104 68 H 112 M104 74 H 110" />
      <Sparkle x={144} y={16} r={5} />
    </Sketch>
  );
}

/* ------------------------------------------------------------------ */
/* Banner: stacked page edges on one side, a music staff on the other. */
/* ------------------------------------------------------------------ */
export function BannerPattern({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1200 420" preserveAspectRatio="xMidYMid slice" className={className} aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round">
      {/* music staff sweeping across the left */}
      {[0, 1, 2, 3, 4].map((i) => (
        <path key={`s${i}`} d={`M-20 ${120 + i * 14} C 140 ${60 + i * 14}, 300 ${220 + i * 14}, 520 ${150 + i * 14}`} />
      ))}
      {[80, 190, 300, 410].map((x, i) => (
        <g key={x} transform={`translate(${x} ${140 + (i % 2 ? 26 : -4)})`}>
          <ellipse rx="8" ry="5.5" transform="rotate(-22)" />
          <path d="M7 -2 V -36" />
        </g>
      ))}
      {/* book page edges fanning on the right */}
      {Array.from({ length: 18 }, (_, i) => (
        <path key={`p${i}`} d={`M${760 + i * 3} ${440} C ${800 + i * 6} ${300 - i * 4}, ${980 + i * 4} ${240 - i * 6}, ${1240} ${200 - i * 8}`} />
      ))}
    </svg>
  );
}
