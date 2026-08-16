/* =========================================================================
   UNITED — free advertising board
   Firebase Auth + Firestore. Vanilla JS, no build step.

   SETUP (do this before deploying):
   1. Firebase project "united-6962b" — config is already wired up below.
      Just make sure Authentication (Email/Password + Google) and
      Firestore are enabled for that project in the Firebase console.
   2. Firestore security rules (paste into Firebase console > Firestore > Rules):

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
              // owner editing their own listing
              (resource.data.ownerId == request.auth.uid) ||
              // anyone incrementing view/like counters only
              request.resource.data.diff(resource.data).affectedKeys()
                .hasOnly(['viewCount', 'likeCount'])
            );
            allow delete: if request.auth != null && resource.data.ownerId == request.auth.uid;
          }
          match /users/{userId}/likes/{siteId} {
            allow read: if request.auth != null && request.auth.uid == userId;
            allow write: if request.auth != null && request.auth.uid == userId;
          }
        }
      }

   3. Firestore will prompt you to create a composite index the first time
      a filtered+sorted query runs — just click the link it gives you in
      the console/network error.
   ========================================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-analytics.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut, updateProfile,
  GoogleAuthProvider, signInWithPopup
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import {
  getFirestore, collection, addDoc, doc, setDoc, deleteDoc, getDocs,
  onSnapshot, query, orderBy, serverTimestamp, increment, updateDoc
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAJRVG5eBdXpGVs-BYf4QJ7kF7kd5bGR64",
  authDomain: "united-6962b.firebaseapp.com",
  projectId: "united-6962b",
  storageBucket: "united-6962b.firebasestorage.app",
  messagingSenderId: "944349399525",
  appId: "1:944349399525:web:e42a4bdc0e411fc71f870c",
  measurementId: "G-WGLE3HEVRM"
};

const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const auth = getAuth(app);
const db = getFirestore(app);

/* ---------- state ---------- */
let currentUser = null;
let allSites = [];
let likedSiteIds = new Set();
let currentCategory = "all";
let currentSort = "trending";
let searchTerm = "";

/* ---------- helpers ---------- */
const $ = (id) => document.getElementById(id);
const CATEGORY_LABELS = {
  tools: "Tools & apps", games: "Games", shops: "Shops & products",
  blogs: "Blogs & writing", art: "Art & portfolios",
  community: "Communities", other: "Other"
};

function normalizeUrl(raw) {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  return url;
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return url; }
}

function faviconFor(url) {
  const domain = domainOf(url);
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

function timeAgo(date) {
  if (!date) return "just now";
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function initials(nameOrEmail) {
  const s = (nameOrEmail || "?").trim();
  return s.charAt(0).toUpperCase();
}

/* ---------- modals ---------- */
function openModal(id) { $(id).classList.add("open"); }
function closeModal(id) { $(id).classList.remove("open"); }

document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => closeModal(btn.dataset.close));
});
document.querySelectorAll(".modal-overlay").forEach((overlay) => {
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.classList.remove("open");
  });
});

function requireAuthOrOpen() {
  if (currentUser) return true;
  openModal("authOverlay");
  return false;
}

$("heroSubmitLink").addEventListener("click", () => {
  if (requireAuthOrOpen()) openModal("submitOverlay");
});
$("ctaSubmitBtn").addEventListener("click", () => {
  if (requireAuthOrOpen()) openModal("submitOverlay");
});
$("emptySubmitBtn")?.addEventListener("click", () => {
  if (requireAuthOrOpen()) openModal("submitOverlay");
});

/* ---------- auth UI ---------- */
let authMode = "signin";

document.querySelectorAll("[data-auth-tab]").forEach((tab) => {
  tab.addEventListener("click", () => {
    authMode = tab.dataset.authTab;
    document.querySelectorAll("[data-auth-tab]").forEach((t) => {
      t.classList.toggle("active", t === tab);
      t.setAttribute("aria-selected", t === tab ? "true" : "false");
    });
    $("displayNameGroup").hidden = authMode !== "signup";
    $("authModalTitle").textContent = authMode === "signin" ? "Welcome back" : "Join the board";
    $("authModalSub").textContent = authMode === "signin"
      ? "Sign in to list a site, like listings, and track your board."
      : "Free account. Takes about ten seconds.";
    $("authSubmitBtn").textContent = authMode === "signin" ? "Sign in" : "Create account";
    $("authError").hidden = true;
  });
});

$("authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;
  const displayName = $("authDisplayName").value.trim();
  const errorEl = $("authError");
  errorEl.hidden = true;
  $("authSubmitBtn").disabled = true;

  try {
    if (authMode === "signup") {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      if (displayName) await updateProfile(cred.user, { displayName });
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
    closeModal("authOverlay");
    e.target.reset();
  } catch (err) {
    errorEl.textContent = friendlyAuthError(err.code);
    errorEl.hidden = false;
  } finally {
    $("authSubmitBtn").disabled = false;
  }
});

$("googleAuthBtn").addEventListener("click", async () => {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
    closeModal("authOverlay");
  } catch (err) {
    const errorEl = $("authError");
    errorEl.textContent = friendlyAuthError(err.code);
    errorEl.hidden = false;
  }
});

function friendlyAuthError(code) {
  const map = {
    "auth/email-already-in-use": "That email already has an account — try signing in instead.",
    "auth/invalid-email": "That email doesn't look right.",
    "auth/weak-password": "Password needs to be at least 6 characters.",
    "auth/wrong-password": "Wrong password.",
    "auth/user-not-found": "No account with that email.",
    "auth/invalid-credential": "Email or password is wrong.",
    "auth/popup-closed-by-user": "Sign-in was closed before it finished."
  };
  return map[code] || "Something went wrong. Try again.";
}

function renderAuthArea() {
  const area = $("authArea");
  if (!currentUser) {
    area.innerHTML = `
      <button class="btn btn-ghost" type="button" id="signInBtn">Sign in</button>
      <button class="btn btn-primary btn-small" type="button" id="getStartedBtn">Get started</button>
    `;
    $("signInBtn").addEventListener("click", () => { authMode = "signin"; openModal("authOverlay"); });
    $("getStartedBtn").addEventListener("click", () => {
      document.querySelector('[data-auth-tab="signup"]').click();
      openModal("authOverlay");
    });
    $("mineChip").hidden = true;
  } else {
    const label = currentUser.displayName || currentUser.email;
    area.innerHTML = `
      <div class="user-chip" id="userChip">
        <span class="user-avatar">${initials(label)}</span>
        <span>${label.split("@")[0]}</span>
        <div class="user-dropdown" id="userDropdown">
          <button type="button" id="signOutBtn">Sign out</button>
        </div>
      </div>
    `;
    $("userChip").addEventListener("click", (e) => {
      e.stopPropagation();
      $("userDropdown").classList.toggle("open");
    });
    document.addEventListener("click", () => $("userDropdown")?.classList.remove("open"), { once: true });
    $("signOutBtn").addEventListener("click", () => signOut(auth));
    $("mineChip").hidden = false;
  }
}

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  renderAuthArea();
  listenToLikes();
  renderGrid();
});

/* ---------- likes (per-user subcollection) ---------- */
let unsubLikes = null;
function listenToLikes() {
  if (unsubLikes) { unsubLikes(); unsubLikes = null; }
  likedSiteIds = new Set();
  if (!currentUser) { renderGrid(); return; }
  unsubLikes = onSnapshot(collection(db, "users", currentUser.uid, "likes"), (snap) => {
    likedSiteIds = new Set(snap.docs.map((d) => d.id));
    renderGrid();
  });
}

async function toggleLike(siteId, currentLikeCount) {
  if (!requireAuthOrOpen()) return;
  const likeRef = doc(db, "users", currentUser.uid, "likes", siteId);
  const siteRef = doc(db, "sites", siteId);
  const alreadyLiked = likedSiteIds.has(siteId);
  try {
    if (alreadyLiked) {
      await deleteDoc(likeRef);
      await updateDoc(siteRef, { likeCount: increment(-1) });
    } else {
      await setDoc(likeRef, { likedAt: serverTimestamp() });
      await updateDoc(siteRef, { likeCount: increment(1) });
    }
  } catch (err) {
    console.error("Like toggle failed:", err);
  }
}

async function visitSite(siteId, url) {
  try { await updateDoc(doc(db, "sites", siteId), { viewCount: increment(1) }); }
  catch (err) { console.error("View increment failed:", err); }
  window.open(normalizeUrl(url), "_blank", "noopener");
}

async function deleteSite(siteId) {
  if (!confirm("Remove this listing from the board?")) return;
  try { await deleteDoc(doc(db, "sites", siteId)); }
  catch (err) { console.error("Delete failed:", err); }
}

/* ---------- submit form ---------- */
const descInput = $("siteDescription");
descInput.addEventListener("input", () => {
  $("descCharCount").textContent = `${140 - descInput.value.length} left`;
});

$("submitForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentUser) { openModal("authOverlay"); return; }

  const title = $("siteTitle").value.trim();
  const rawUrl = $("siteUrl").value.trim();
  const category = $("siteCategory").value;
  const description = $("siteDescription").value.trim();
  const errorEl = $("submitError");
  errorEl.hidden = true;

  let url;
  try { url = normalizeUrl(rawUrl); new URL(url); }
  catch { errorEl.textContent = "That URL doesn't look valid."; errorEl.hidden = false; return; }

  $("submitSiteBtn").disabled = true;
  try {
    await addDoc(collection(db, "sites"), {
      title, url, category, description,
      ownerId: currentUser.uid,
      ownerName: currentUser.displayName || currentUser.email,
      createdAt: serverTimestamp(),
      likeCount: 0,
      viewCount: 0
    });
    e.target.reset();
    $("descCharCount").textContent = "140 left";
    closeModal("submitOverlay");
  } catch (err) {
    errorEl.textContent = "Couldn't submit that — try again in a moment.";
    errorEl.hidden = false;
    console.error(err);
  } finally {
    $("submitSiteBtn").disabled = false;
  }
});

/* ---------- board data + rendering ---------- */
onSnapshot(query(collection(db, "sites"), orderBy("createdAt", "desc")), (snap) => {
  allSites = snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      ...data,
      createdAtDate: data.createdAt?.toDate ? data.createdAt.toDate() : null
    };
  });
  $("boardLoading").hidden = true;
  renderGrid();
}, (err) => {
  console.error(err);
  $("boardLoading").textContent = "Couldn't load the board. Check your Firebase config in script.js.";
});

function renderGrid() {
  const grid = $("siteGrid");
  let list = [...allSites];

  if (currentCategory === "mine") {
    list = currentUser ? list.filter((s) => s.ownerId === currentUser.uid) : [];
  } else if (currentCategory !== "all") {
    list = list.filter((s) => s.category === currentCategory);
  }

  if (searchTerm) {
    const q = searchTerm.toLowerCase();
    list = list.filter((s) =>
      s.title?.toLowerCase().includes(q) ||
      s.description?.toLowerCase().includes(q) ||
      domainOf(s.url || "").toLowerCase().includes(q)
    );
  }

  if (currentSort === "trending") {
    list.sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0));
  } else if (currentSort === "viewed") {
    list.sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0));
  } else {
    list.sort((a, b) => (b.createdAtDate?.getTime() || 0) - (a.createdAtDate?.getTime() || 0));
  }

  $("boardEmpty").hidden = list.length !== 0 || !$("boardLoading").hidden;
  grid.innerHTML = list.map(cardHTML).join("");

  grid.querySelectorAll("[data-visit]").forEach((el) => {
    el.addEventListener("click", () => visitSite(el.dataset.visit, el.dataset.url));
  });
  grid.querySelectorAll("[data-like]").forEach((el) => {
    el.addEventListener("click", () => toggleLike(el.dataset.like, Number(el.dataset.count)));
  });
  grid.querySelectorAll("[data-delete]").forEach((el) => {
    el.addEventListener("click", (e) => { e.stopPropagation(); deleteSite(el.dataset.delete); });
  });
}

function cardHTML(site) {
  const liked = likedSiteIds.has(site.id);
  const isOwner = currentUser && site.ownerId === currentUser.uid;
  const domain = domainOf(site.url || "");
  const safeTitle = escapeHTML(site.title || domain);
  const safeDesc = escapeHTML(site.description || "");
  return `
    <article class="site-card${isOwner ? " is-owner" : ""}">
      ${isOwner ? `<button class="card-delete" type="button" data-delete="${site.id}" aria-label="Remove listing">&times;</button>` : ""}
      <div class="card-top">
        <img class="card-favicon" src="${faviconFor(site.url)}" alt="" width="28" height="28" loading="lazy">
        <div class="card-heading">
          <span class="card-title">${safeTitle}</span>
          <span class="card-domain">${escapeHTML(domain)}</span>
        </div>
        <span class="card-tag">${CATEGORY_LABELS[site.category] || "Other"}</span>
      </div>
      <p class="card-desc">${safeDesc}</p>
      <div class="card-footer">
        <button class="like-btn${liked ? " liked" : ""}" type="button" data-like="${site.id}" data-count="${site.likeCount || 0}">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="${liked ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M8 14s-6-3.6-6-8.1C2 3.5 3.7 2 5.7 2 6.8 2 7.6 2.6 8 3.4 8.4 2.6 9.2 2 10.3 2c2 0 3.7 1.5 3.7 3.9C14 10.4 8 14 8 14z"/></svg>
          <span>${site.likeCount || 0}</span>
        </button>
        <span class="view-count">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></svg>
          ${site.viewCount || 0}
        </span>
        <a class="visit-btn" href="#" data-visit="${site.id}" data-url="${escapeHTML(site.url)}">Visit →</a>
      </div>
    </article>
  `;
}

function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

/* ---------- controls ---------- */
$("searchInput").addEventListener("input", (e) => { searchTerm = e.target.value; renderGrid(); });
$("sortSelect").addEventListener("change", (e) => { currentSort = e.target.value; renderGrid(); });
document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    currentCategory = chip.dataset.category;
    document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === chip));
    renderGrid();
  });
});

/* ---------- header scroll state ---------- */
const header = $("siteHeader");
const onScroll = () => header.classList.toggle("scrolled", window.scrollY > 12);
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

/* ---------- hero demo card tilt ---------- */
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const demoCard = $("demoCard");
const hero = $("hero");
if (demoCard && hero && !prefersReducedMotion) {
  hero.addEventListener("mousemove", (event) => {
    const rect = hero.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    demoCard.style.transform = `rotate(${x * 4}deg) translate(${x * 10}px, ${y * 10}px)`;
  });
  hero.addEventListener("mouseleave", () => {
    demoCard.style.transform = "rotate(0deg) translate(0, 0)";
  });
}
