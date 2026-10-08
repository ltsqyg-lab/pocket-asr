#!/usr/bin/env python3
# Minimal Vosk transcriber for pocket-asr: reads a 16 kHz mono 16-bit WAV directly (no ffmpeg) and takes the same
# flags pocket-asr passes to vosk-transcriber:  -m <model dir> -i <file.wav> -o <out.txt> [-t txt] [--log-level X]
# Needs only `pip install vosk`. Prints nothing but errors; writes the text to -o.
# License: AGPL-3.0-only (part of pocket-asr).

import argparse
import json
import sys
import wave


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-m', '--model', required=True)
    ap.add_argument('-i', '--input', required=True)
    ap.add_argument('-o', '--output', required=True)
    ap.add_argument('-t', '--output-type', default='txt')
    ap.add_argument('--log-level', default='ERROR')
    a = ap.parse_args()

    import vosk
    vosk.SetLogLevel(-1)
    with wave.open(a.input, 'rb') as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2 or w.getframerate() != 16000:
            print('expected 16 kHz mono 16-bit PCM', file=sys.stderr)
            return 2
        rec = vosk.KaldiRecognizer(vosk.Model(a.model), 16000)
        parts = []
        while True:
            data = w.readframes(8000)
            if not data:
                break
            if rec.AcceptWaveform(data):
                parts.append(json.loads(rec.Result()).get('text', ''))
        parts.append(json.loads(rec.FinalResult()).get('text', ''))
    with open(a.output, 'w', encoding='utf-8') as f:
        f.write(' '.join(p for p in parts if p).strip() + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
