# Image Manager for SillyTavern

A storage-focused image manager for SillyTavern's `user/images` folder — the
place where inline chat images and generated images pile up. Built for people
(especially on **mobile**) whose SillyTavern gets heavy and slow because old
images never get cleaned out.

The built-in Gallery only shows one character's images at a time and deletes
one file at a time. This extension is for **cleaning up storage**: see every
folder at once, measure how much space you're using, and bulk-delete or clean
out old images fast.

## Features

- **All folders in one place** — browse every character's image folder, or
  filter to a single one.
- **Storage usage** — shows how many images you have and roughly how many MB
  they take. File sizes are measured lazily (HEAD requests) so it stays light
  on mobile data.
- **Multi-select + bulk delete** — tick images and delete them all at once,
  with a confirmation that tells you how much space you'll free.
- **Clean Old** — delete everything older than N days. Reads the timestamp
  from the image filename when available and shows the space it will free
  before you confirm.
- **Hide** — hide images you don't want cluttering the manager without
  deleting the files. Toggle "Show hidden" to see them again.
- **View** — tap an image to open it full size (images and videos).
- **Search & sort** — filter by file name, sort by date or name.
- **Mobile friendly** — full-screen layout, collapsible folder list, native
  lazy-loaded thumbnails.

## How to open

- **Wand menu** (the magic-wand / extensions menu next to the chat input):
  click **Image Manager**.
- Or run the slash command `/image-manager` (alias `/im`).

## How it works

The extension is purely client-side. It uses SillyTavern's existing image API:

- `POST /api/images/folders` — list image folders
- `POST /api/images/list` — list files in a folder
- `POST /api/images/delete` — delete a file

Deletions are permanent and remove the file from the server. They cannot be
undone, so confirmations are always shown.

## Install

Install from URL in **Extensions → Install Extension**, or clone into:

```
SillyTavern/data/<user>/extensions/ST-ImageManager
```

(or `public/scripts/extensions/third-party/ST-ImageManager` for a global
install).

## Notes

- "Clean Old" only deletes images whose age it can read from the filename
  (SillyTavern names inline/generated images with a `Date.now()` timestamp).
  Images with no readable date are skipped to stay safe.
- "Hide" is stored in the extension settings, not on the server.
