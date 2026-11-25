# Explore AI Out Loud Studio

Explore AI Out Loud Studio is the production studio behind the Explore AI Out Loud podcast. It runs on your own computer and takes a two-camera, two-microphone recording from raw files to a rendered episode, social clips and release copy, with a person approving each stage. It is for a two-host video podcast that records one camera and one microphone per host and wants a repeatable, inspectable edit without a hosted service. The show's own details (name, hosts, links, channel mapping) live in one config file, so it works for any two-host podcast.

Author: Santosh Savel

## What it does

1. **Ingest.** Checks every source file with ffprobe, records its size and modified time, hashes every microphone part, and joins microphone recordings that were split into parts.
2. **Audio sync.** Finds the offset between each camera and microphone by correlating loudness envelopes, and measures drift between the start and end.
3. **Microphone channel preflight.** Confirms each host is on the channel or file you assigned before anything depends on it.
4. **Speaker activity.** Marks who is speaking, both speaking, or silence, from the isolated microphones.
5. **Camera plan.** Writes a shot list where every shot carries a reason code. In this version the full-episode plan is a side-by-side two-shot; solo shots are a choice you make in the assembly step.
6. **Episode assembly and render.** Combines opening, program, call-to-action graphics and closing into a low-resolution proxy for review, then a full render.
7. **Delivery files.** Audio-only file with loudness checks, captions, transcript and chapters.
8. **Social clips.** Candidate review, vertical renders, captions and a post kit.
9. **Release copy.** Titles, descriptions and show notes built from your configured links.

## Design principles

- **Local-first.** Media and processing stay on your computer. The server listens on `127.0.0.1` only and the code makes no outbound network calls.
- **A human approval between stages.** A person approves the sync result, aligned playback, the transcript, the episode title, the assembly recipe, the proxy render, each clip and each social package before the next stage will run. Measurement steps that follow one another (channel check, speaker activity, camera plan) are chained by receipts instead. Title, clip and social approvals also record which host made them.
- **Receipts that go stale when inputs change.** Each stage writes a JSON receipt bound to its inputs: file path, size and modified time for sources, content hashes for microphone parts and rendered outputs, and fingerprints of earlier receipts. If a source file or an earlier decision changes, later receipts are marked stale and the stage must be run again.

## Pipeline

```
 cameras (2) + microphones (2)
            |
        [ ingest ] ---------------> episode.json
            |
        [ audio sync ] -----------> sync.json            approve
            |
        [ timeline ] -------------> timeline.json        approve playback
            |
        [ channel preflight ] ----> channel_preflight.json
            |
        [ speaker activity ] -----> speaker_activity.json
            |
        [ camera plan ] ----------> camera_decision_manifest.json (reason code per shot)
            |
        [ transcript ] (whisper.cpp, optional) ---------  approve
            |
     +------+----------------------+
     |                             |
 [ episode assembly ]  approve   [ clip candidates ]  approve
     |                             |
 [ proxy render ]      approve   [ clip render ]      approve
     |                             |
 [ full render ]                 [ post kit ]
     |
 [ audio, captions, chapters ]
     |
 [ release copy ]

 Every box writes a receipt. Change an input and the receipts below it go stale.
```

## Quick start

You need three things: Node.js 20 or newer, and ffmpeg with ffprobe. ffmpeg must include the subtitles filter (libass), which the caption renders use. Transcription with whisper.cpp is optional; see below.

### Install on macOS

With [Homebrew](https://brew.sh):

```
brew install node ffmpeg-full
```

Studio looks for `ffmpeg-full` first and falls back to any `ffmpeg` on your `PATH`. This is the platform the studio is developed and run on.

### Install on Linux

On Debian or Ubuntu:

```
sudo apt-get update
sudo apt-get install -y ffmpeg
```

The distribution's ffmpeg includes ffprobe and the subtitles filter. Install Node.js 20 or newer from [nodejs.org](https://nodejs.org/en/download) or with a version manager such as nvm; the Node.js in older distribution repositories is too old. The automated tests run on Ubuntu. Linux has no system file picker in Studio, so paste full file paths where the page asks for a file.

### Install on Windows

In PowerShell, with [winget](https://learn.microsoft.com/windows/package-manager/winget/):

```
winget install OpenJS.NodeJS.LTS
winget install Gyan.FFmpeg
```

Open a new terminal afterwards so `node`, `ffmpeg` and `ffprobe` are on your `PATH`. If you keep ffmpeg somewhere else, set `EAOL_FFMPEG` and `EAOL_FFPROBE` to the full paths. Use Node.js 22 or newer on Windows: `npm test` relies on Node expanding the test file patterns itself. Windows support is written but has not been tested in this version; please open an issue if a step fails.

### Run it

The same commands work on all three:

```
npm install
npm run setup:check      # reports Node, ffmpeg, and whether whisper is present
npm test                 # runs the tests on generated media
npm run demo:episode     # generates a 60 second synthetic episode and ingests it
npm run studio           # then open http://127.0.0.1:4173
```

The synthetic episode is colour bars and gated noise made by ffmpeg. It is written to `tmp/` and `work/`, which git ignores. In Studio, choose `synthetic_episode` and work through sync, the channel check, speaker activity and the camera plan. Those stages run without whisper.

Transcription is optional and separate. Install [whisper.cpp](https://github.com/ggerganov/whisper.cpp) so `whisper-cli` is on your `PATH`, and download the `ggml-small.en.bin` model into `models/`.

- **macOS:** `brew install whisper-cpp`.
- **Linux:** build whisper.cpp from source following its README, then put `whisper-cli` on your `PATH` or set `EAOL_WHISPER_CLI` to its full path.
- **Windows:** download a release build from the whisper.cpp releases page and either place `whisper-cli.exe` in `.local\whisper\` inside this folder or set `EAOL_WHISPER_CLI` to its full path.

`npm run setup:check` reports whether whisper and the model were found. `node transcribe.mjs --input <file>` prints the download command if the model is missing. The stages that depend on words (transcript review, episode naming, assembly, clips, captions) need a transcript.

To use your own recording, choose **New episode** in Studio and give it the full paths to each camera and microphone file. That intake also transcribes the Host 1 camera. If whisper or the model is missing, the job ends with an error that prints the model download command; the source receipt is still written.

There is also a command-line path for a single recording: `transcribe.mjs` (transcribe), `render.mjs` (cut and caption vertical clips from a `clips.json`) and `tiles.mjs` (episode tiles). Each has a `--self-test`.

## Tests

`npm test` runs 109 tests across 52 files with Node's built-in runner. They use temporary folders and media generated by ffmpeg at test time. No recordings, models or network access are needed. They cover:

- Sync, timeline, channel preflight, speaker activity and camera plan logic.
- An end-to-end run on the synthetic episode through the HTTP routes the page uses, including recovering known sync offsets and receipts going stale after a source file changes.
- Episode assembly, the renderer, delivery audio and text, and the proxy review receipts.
- Social clip planning, rendering, finishing and delivery receipts.
- Release copy and the config-driven link and chapter rules.
- The server's local-only request checks, job state and recovery after an interrupted job.
- The stereo split channel mapping setting.
- The command-line self-tests.

## How clip selection works

The code makes no model calls. Clip choice is done by an AI coding agent (or a person) following `clip_rubric.md`: it reads the transcript, picks moments, and writes them to `work/<episode>/clips.json`. The code validates that file, shows the candidates for human approval, and renders the approved ones. Studio can also propose candidates from the transcript with fixed text rules; that step is deterministic and uses no model.

## Configuration

Edit `show.config.json` in the repository root. The values that ship are fictional examples.

| Key | Meaning |
| --- | --- |
| `show_name` | Shown in the page and used as the default graphic label. Titles may not repeat it. |
| `hosts.host_1`, `hosts.host_2` | Display names for the two hosts. Host 1 is the primary camera. |
| `links.website` | The show's page. Links on this host get campaign tags in release copy. |
| `links.apple_podcasts`, `links.spotify` | Listening links for descriptions. Leave empty to omit. |
| `links.newsletter_name`, `links.newsletter` | Optional newsletter line and its spoken-mention detection. |
| `release.cadence_line` | Optional last line of the video description. |
| `release.chapters` | Optional recurring-segment rules: from which episode, minimum count and length, and required segment names. |
| `audio.channel_mapping` | For a stereo split recording, which host is on the left channel (`"left": "host_1"` or `"host_2"`). Two separate mono files need no mapping. |
| `social.show_hashtag` | The hashtag that must come first on every social post. Defaults to the show name without spaces. |
| `social.cover_tagline` | Optional line on generated social covers. |
| `social.topic_keywords` | Words that name your subject, used as one signal in clip suggestions. |
| `tiles.presented_by` | Small line on generated tiles. |

### Channel slate for a stereo split recording

If both hosts share one stereo file (one host per channel), start the recording with a 17 second slate so the channel check has something to measure: 2 seconds of quiet, Host 1 alone for 3 seconds, 2 seconds of quiet, Host 2 alone for 3 seconds, 2 seconds of quiet, both together for 3 seconds, then 2 seconds of quiet. With two separate mono files the check only confirms the two files are different, and you confirm the roles when you review the labelled transcript.

### Environment variables

Set `EAOL_SHOW_CONFIG` to use a config file elsewhere. `EAOL_STUDIO_PORT` changes the port. `EAOL_FFMPEG`, `EAOL_FFPROBE` and `EAOL_WHISPER_CLI` point to specific binaries.

## Limits and what is not included

- This is a scaled-down version of a working studio. Parts tied to one show's storage, analytics, co-host handoff and platform exports were removed.
- There is no hosted service, no accounts and no upload or publishing. Copying files anywhere and posting them is up to you.
- Whisper is optional and is not bundled. Without it you can run the stages up to the camera plan.
- Normal intake expects one continuous camera file per host. A recording with camera restarts goes through the assisted "recovered episode" import, which supports camera drafts, short previews and opening and closing transitions but not a full export.
- The automatic camera plan for a full episode is side-by-side only.
- Developed and used on macOS. The automated tests run on Linux. Windows setup is documented but untested in this version.
- The file pickers use macOS and Windows system dialogs; on Linux, paste full paths.

## How this was built

I build with AI coding agents. I design the system, write the specifications and the evaluations, and review what ships; the agents write the code.

## License

MIT. See `LICENSE`. The Inter font files in `fonts/` are under the SIL Open Font License; see `fonts/OFL-LICENSE.txt`.
