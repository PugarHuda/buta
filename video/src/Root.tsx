import React from "react";
import { Composition } from "remotion";
import { Demo } from "./Demo";
import { FPS, TOTAL_FRAMES } from "./script";

/**
 * Two compositions off one timeline.
 *
 * `Demo` renders silent, which is what you want while you are still cutting it.
 * `DemoVoiced` expects public/vo.wav, a recording in your own voice made to
 * src/script.ts. Flare disqualifies AI voice, so nothing here synthesises one.
 */
export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="Demo"
      component={Demo}
      durationInFrames={TOTAL_FRAMES}
      fps={FPS}
      width={1920}
      height={1080}
      defaultProps={{ withVoice: false }}
    />
    <Composition
      id="DemoVoiced"
      component={Demo}
      durationInFrames={TOTAL_FRAMES}
      fps={FPS}
      width={1920}
      height={1080}
      defaultProps={{ withVoice: true }}
    />
  </>
);
