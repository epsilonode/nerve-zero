# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Multilingual voice control across 12 languages: `en`, `zh`, `hi`, `es`, `fr`, `ar`, `bn`, `pt`, `ru`, `ja`, `de`, `tr`.
- Language and phrase APIs for runtime voice configuration:
  - `GET/PUT /api/language`
  - `GET /api/language/support`
  - `GET/PUT /api/transcribe/config`
  - `GET /api/voice-phrases`
  - `GET /api/voice-phrases/status`
  - `GET/PUT /api/voice-phrases/:lang`
- Mutex-protected env writer (`server/lib/env-file.ts`) to serialize `.env` updates.

### Changed
- Voice language is now explicit (auto-detect removed from UI flow).
- Default/fallback language behavior is English (`en`) for missing/invalid values.
- Primary env key is now `NERVE_LANGUAGE` (legacy `LANGUAGE` remains a read fallback).
- Wake phrase behavior is single-primary-phrase per language (custom phrase takes precedence).
- Settings categories are now `Connection`, `Audio`, and `Appearance`.
- Voice phrase overrides now persist as runtime state at `~/.nerve/voice-phrases.json` (configurable via `NERVE_VOICE_PHRASES_PATH`).
- Local STT default model is now multilingual `tiny`.

### Fixed
- Unicode-safe stop/cancel matching for non-Latin scripts (removed brittle `\b` behavior).
- Reduced Latin stop-phrase false positives inside larger words.
- Wake phrase edits now apply immediately in-session (no page refresh required).
- Edge TTS SSML locale now derives from selected voice locale (not hardcoded `en-US`).
- Improved 4xx/5xx separation for language/transcribe config update failures.
- Improved voice-phrase modal reliability (load/save error handling and request-abort race handling).
- Accessibility: icon-only remove-phrase controls now include accessible labels.

### Documentation
- Updated API, architecture, configuration, troubleshooting, installer notes, and README to match multilingual voice behavior and runtime config.
- Removed internal planning notes from public docs.
