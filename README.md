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
- **Chat visibility filter** — show all images, only those visible in the
  current chat, or only those not visible in it. Works with folder selection,
  favorites, the recycle bin, counts and selection across every page.
- **Clean Old** — delete everything older than N days. Reads the timestamp
  from the image filename when available and shows the space it will free
  before you confirm.
- **Hide** — hide images you don't want cluttering the manager without
  deleting the files. Toggle "Show hidden" to see them again.
- **Recycle bin** — send images to a soft trash instead of deleting them
  outright (per-image, bulk, or from the viewer). Files stay on disk, so you
  can restore them later or empty the bin to remove them for good. Optional
  auto-clean purges trashed items older than 7/14/30/90 days. The trashed list
  lives in the extension settings, not on the server.
- **View** — tap an image to open it full size (images and videos), flip
  through the whole view with arrows/swipe. Zoom with the +/− controls on
  desktop, or pinch-to-zoom / double-tap on touch devices.
- **Find & sort** — find a character's folder by name from the toolbar, sort
  images by date, name or file size.
- **Mobile friendly** — full-screen layout, collapsible folder list, native
  lazy-loaded thumbnails.

## How to open

- **Wand menu** (the magic-wand / extensions menu next to the chat input):
  click **Image Manager**.
- Or run the slash command `/image-manager` (alias `/im`).

## How it works

### Delete images not visible in the current chat

1. Open the chat, then open **Image Manager**.
2. Choose the character's folder (selected automatically when available), or
   **All images** in the sidebar to include every folder.
3. Choose **Not visible in chat** in the toolbar.
4. Click the double-check **Select all** button, then **Delete** and confirm.
   Favorites remain protected. You can also move the selection to the recycle bin.

Visibility is checked against **the entire currently open chat**, including
messages above the scroll position and older messages not yet rendered on screen.
For rendered messages, the filter reads the actual picture currently displayed
in the chat, including replacements made by third-party generators. For older
messages not yet rendered, it reads the active text and image/video attachments.
Inactive message swipes and unselected images in a media gallery
count as not visible; a media list counts all its displayed attachments.
It refreshes when the chat changes, when messages/images change, and on **Refresh**.
Changing the visibility filter clears the selection.

**Other chats and branches are not scanned:** “not visible” means absent from the
current chat view, not unused everywhere. Files may still be referenced by another
chat or an inactive swipe. When no chat is open, the two chat-specific modes show
an empty view with a prompt to open a chat; **All images** remains available.

### Server API

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
