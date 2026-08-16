# United — free advertising board

A free site-directory / advertising board. Anyone can create an account,
submit a link, and other users can like it. Every listing shows a live
view count that ticks up whenever someone clicks "Visit."

Vanilla JS, no build step. Firebase Auth + Firestore for the backend —
same pattern as your other Firebase-backed projects, just plug your
project config in.

## Files

- `index.html` — markup, auth modal, submit modal
- `style.css` — theme (carried over from the Platypus palette: ink/coffee/clay/cream/amber, Fraunces + Inter + JetBrains Mono)
- `script.js` — Firebase init, auth, Firestore reads/writes, all UI logic

## Setup

The Firebase config for project `united-6962b` is already wired into
`script.js` (SDK v12.17.1, with Analytics enabled). Just do the rest in
the Firebase console:

1. **Auth** — enable the *Email/Password* and *Google* sign-in providers
   under Authentication → Sign-in method.
2. **Firestore** — create a Firestore database (production mode) if you
   haven't already.
3. **Security rules** — paste the ruleset from the comment block at the
   top of `script.js` into Firestore → Rules. It:
   - lets anyone read listings
   - lets a signed-in user create a listing owned by themselves
   - lets anyone update *only* `viewCount`/`likeCount` on a listing (so
     views/likes work without giving write access to everything else)
   - lets a signed-in user edit/delete their own listing
   - keeps each user's `likes` subcollection private to them
4. **Composite index** — the first time the "Trending" or "Most viewed"
   sort runs against real data, Firestore may ask for a composite index
   via a link in the browser console. Click it once and it's done.
5. Deploy the three files as-is to GitHub Pages (or wherever) — no build
   step required.

If you ever move this to a different Firebase project, swap the
`firebaseConfig` object near the top of `script.js`.

## Data model

```
sites/{siteId}
  title, url, category, description
  ownerId, ownerName
  createdAt (server timestamp)
  likeCount, viewCount

users/{uid}/likes/{siteId}
  likedAt (server timestamp)
```

`likes` is a per-user subcollection rather than an array on the site
doc, so checking "did I like this" and toggling it doesn't require
reading every other user's like.

## Notes / things you may want to change

- Like/view counters use `increment()` with two small writes rather than
  a transaction — fine at this scale, but a heavy simultaneous-click
  storm could in theory drift the count slightly. Wrap in
  `runTransaction` later if that ever matters.
- Favicons are pulled live from Google's favicon service
  (`s2/favicons?domain=...`) — no image storage needed.
- Deleting a listing doesn't currently clean up other users' `likes`
  subcollection entries pointing at it (harmless, just unused docs) —
  a Cloud Function trigger on delete would tidy that up if you want it.
- No moderation/reporting flow yet — everything submitted goes live
  immediately.
