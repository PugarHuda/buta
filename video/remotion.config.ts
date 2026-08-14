import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
// The clips are webm screen recordings; h264 keeps the output playable in a
// DoraHacks tab and in whatever a judge has installed.
Config.setCodec("h264");
