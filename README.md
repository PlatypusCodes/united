# United — free advertising board

A free site directory. Anyone can create an account, submit a link, and
other users can like it. Every listing shows a live view count that
ticks up whenever someone clicks "Visit." Users can also edit their own
profile — avatar, display name, short bio.

Vanilla JS, no build step. Firebase Auth + Firestore + Storage.

## Files

| File | Purpose |
|---|---|
| `index.html` | Markup — header, hero, board, and all modals (auth, submit, edit profile) |
| `style.css` | Theme — warm coffee/amber palette, Fraunces + Inter + JetBrains Mono |
| `script.js` | Firebase init, auth, Firestore reads/writes, Storage uploads, all UI logic |

## One-time setup

Project `united-6962b` is already wired into `script.js`. Before going
live, do the following in the [Firebase console](https://console.firebase.google.com):

1. **Authentication** → Sign-in method → enable **Email/Password** and
   **Google**.
2. **Firestore Database** → create a database if one doesn't exist yet
   (production mode).
3. **Storage** → create a default bucket if one doesn't exist yet.
4. **Firestore rules** — Firestore → Rules → paste:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {

       match /sites/{siteId} {
         allow read: if true;
         allow create: if request.auth != null
           && request.resource.data.ownerId == request.auth.uid
           && request.resource.data.likeCount == 0
           && request.resource.data.viewCount == 0;
         allow update: if request.auth != null && (
           resource.data.ownerId == request.auth.uid ||
           request.resource.data.diff(resource.data).affectedKeys()
             .hasOnly(['viewCount', 'likeCount'])
         );
         allow delete: if request.auth != null && resource.data.ownerId == request.auth.uid;
       }

       match /users/{userId} {
         allow read: if true;
         allow write: if request.auth != null && request.auth.uid == userId;

         match /likes/{siteId} {
           allow read, write: if request.auth != null && request.auth.uid == userId;
         }
       }
     }
   }
   ```

5. **Storage rules** — Storage → Rules → paste:

   ```
   rules_version = '2';
   service firebase.storage {
     match /b/{bucket}/o {
       match /avatars/{userId}/{fileName} {
         allow read: if true;
         allow write: if request.auth != null
           && request.auth.uid == userId
           && request.resource.size < 5 * 1024 * 1024
           && request.resource.contentType.matches('image/.*');
       }
     }
   }
   ```

6. **Composite index** — the first time "Trending" or "Most viewed"
   sort runs against real data, Firestore may prompt for a composite
   index via a link in the browser console. Click it once and it's done.
7. Deploy the three files as-is (GitHub Pages or any static host) — no
   build step required.

If you ever move this to a different Firebase project, swap the
`firebaseConfig` object near the top of `script.js`.

## Data model

```
sites/{siteId}
  title, url, category, description
  ownerId, ownerName
  createdAt (server timestamp)
  likeCount, viewCount

users/{uid}
  displayName, photoURL, bio
  updatedAt (server timestamp)

users/{uid}/likes/{siteId}
  likedAt (server timestamp)
```

`likes` is a per-user subcollection rather than an array on the site
doc, so checking "did I like this" and toggling it doesn't require
reading every other user's like. Avatars are uploaded to
`avatars/{uid}/avatar` in Storage; the download URL is cache-busted
with a `?cb=` query param each time it's replaced so a new upload
shows up immediately.

## Known limitations

- Like/view counters use `increment()` with two small writes rather than
  a single transaction — fine at this scale, but a heavy simultaneous
  burst of clicks could in theory drift a count slightly. Wrap in
  `runTransaction` if that ever matters.
- Favicons are pulled live from Google's favicon service — no image
  storage needed for those.
- Deleting a listing doesn't clean up other users' `likes` subcollection
  entries that pointed at it (harmless, just orphaned docs). A Cloud
  Function trigger on delete would tidy that up if you want it.
- Display name / avatar / bio changes don't retroactively update the
  `ownerName` already stored on a user's past listings — only new
  listings pick up the current name. Denormalizing owner info onto
  every card was a deliberate simplification; revisit if listings need
  to always show the latest profile info.
- No moderation or reporting flow — everything submitted goes live
  immediately.
