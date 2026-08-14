# The demo video

Slides and subtitles are code. The desk footage is a real recording of the
deployed product talking to the live enclave, not a mock.

```bash
cd video
npm install
npm run capture     # records the live desk into public/clips/*.webm
npm run render      # writes out/buta-demo.mp4
```

## Recording the voice

**Do not generate one.** Flare disqualifies AI voice and AI video, and this
project deliberately contains nothing that synthesises either.

`src/script.ts` is the script and the timeline in one file. Each beat carries
the words, the seconds they take, and the scene that runs under them, so the
picture, the subtitle and the cut all move together when you change a number.

1. Read `src/script.ts` aloud in your own voice, in one take, following the
   beats in order. The durations are set at about 2.6 words a second, which is
   an unhurried reading pace.
2. Save it as `public/vo.wav`.
3. Render the voiced composition:

```bash
npx remotion render src/index.ts DemoVoiced out/buta-demo-voiced.mp4
```

If a beat runs long, change `seconds` for that beat rather than trimming the
audio. Everything downstream follows.

## Re-cutting

- `src/script.ts` is the only place timing lives.
- `src/Demo.tsx` holds the scenes. `clip-*` beats play a recording; the rest are
  drawn.
- `npm run capture` re-records against whatever the desk currently shows, so a
  fresh auction on the book turns up in the next render.
- `npm run studio` opens Remotion Studio to scrub without rendering.

## If the render says it cannot find a browser

Remotion downloads its own headless shell, and on this machine that download
does not land. Point it at any Chromium you already have:

```bash
npx remotion render src/index.ts Demo out/buta-demo.mp4 \
  --browser-executable "<path to chrome.exe>"
```

Playwright's copy works, and `node -e "console.log(require('playwright').chromium.executablePath())"`
prints where it is.

## What is deliberately absent

- No synthetic voice, for the reason above.
- No stock footage and no invented numbers. Every transaction hash on screen is
  one you can open on the Coston2 explorer, and every clip is the deployed desk.
