/* =========================================================================
   UNITED — free advertising board
   Firebase Auth + Firestore + Storage. Vanilla JS, no build step.
   See README.md for full setup, security rules, and data model.
   ========================================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-analytics.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut, updateProfile,
  GoogleAuthProvider, signInWithPopup
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import {
  getFirestore, collection, addDoc, doc, setDoc, deleteDoc, getDoc,
  onSnapshot, query, orderBy, serverTimestamp, increment, updateDoc
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";
import {
  getStorage, ref, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-storage.js";

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
getAnalytics(app);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_DESCRIPTION_LEN = 140;
const MAX_BIO_LEN = 80;

/* ---------- state ---------- */
let currentUser = null;
let allSites = [];
let likedSiteIds = new Set();
let currentCategory = "all";
let currentSort = "trending";
let searchTerm = "";
let pendingAvatarFile = null;
let currentUserProfile = { bio: "" };

/* ---------- small utilities ---------- */
const $ = (id) => document.getElementById(id);

const CATEGORY_LABELS = {
  tools: "Tools & apps", games: "Games", shops: "Shops & products",
  blogs: "Blogs & writing", art: "Art & portfolios",
  community: "Communities", other: "Other"
};

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function normalizeUrl(raw) {
  const url = raw.trim();
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return url; }
}

function faviconFor(url) {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domainOf(url))}&sz=64`;
}

function initials(nameOrEmail) {
  return (nameOrEmail || "?").trim().charAt(0).toUpperCase();
}

function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function avatarMarkup(user, size = 26) {
  const label = user?.displayName || user?.email || "?";
  if (user?.photoURL) {
    return `<img class="user-avatar user-avatar-img" src="${escapeHTML(user.photoURL)}" alt="" width="${size}" height="${size}">`;
  }
  return `<span class="user-avatar">${initials(label)}</span>`;
}

/* ---------- toast notifications ---------- */
function showToast(message, type = "info") {
  const container = $("toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toast.setAttribute("role", "status");
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("visible"));
  setTimeout(() => {
    toast.classList.remove("visible");
    toast.addEventListener("transitionend", () => toast.remove(), { once: true });
  }, 3200);
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

/* ---------- auth: sign in / sign up ---------- */
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
  const errorEl = $("authError");
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
    closeModal("authOverlay");
  } catch (err) {
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
    "auth/popup-closed-by-user": "Sign-in was closed before it finished.",
    "auth/network-request-failed": "Network error — check your connection and try again."
  };
  return map[code] || "Something went wrong. Try again.";
}

/* ---------- header auth area ---------- */
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
    return;
  }

  const label = currentUser.displayName || currentUser.email;
  area.innerHTML = `
    <div class="user-chip" id="userChip">
      ${avatarMarkup(currentUser)}
      <span>${escapeHTML(label.split("@")[0])}</span>
      <div class="user-dropdown" id="userDropdown">
        <button type="button" id="editProfileBtn">Edit profile</button>
        <button type="button" id="signOutBtn">Sign out</button>
      </div>
    </div>
  `;
  $("userChip").addEventListener("click", (e) => {
    e.stopPropagation();
    $("userDropdown").classList.toggle("open");
  });
  document.addEventListener("click", () => $("userDropdown")?.classList.remove("open"), { once: true });
  $("editProfileBtn").addEventListener("click", openProfileModal);
  $("signOutBtn").addEventListener("click", () => signOut(auth));
  $("mineChip").hidden = false;
}

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  currentUserProfile = { bio: "" };
  if (user) {
    try {
      const snap = await getDoc(doc(db, "users", user.uid));
      if (snap.exists()) currentUserProfile.bio = snap.data().bio || "";
    } catch {
      // non-critical — profile bio just won't prefill this session
    }
  }
  renderAuthArea();
  listenToLikes();
  renderGrid();
});

/* ---------- profile editing ---------- */
function openProfileModal() {
  if (!currentUser) return;
  pendingAvatarFile = null;
  $("profileError").hidden = true;
  $("profileDisplayName").value = currentUser.displayName || "";
  $("profileBio").value = currentUserProfile.bio || "";
  $("profileBioCount").textContent = `${MAX_BIO_LEN - (currentUserProfile.bio || "").length} left`;
  setAvatarPreview(currentUser.photoURL);
  openModal("profileOverlay");
}

function setAvatarPreview(src) {
  const preview = $("avatarPreview");
  if (src) {
    preview.innerHTML = `<img src="${escapeHTML(src)}" alt="" width="88" height="88">`;
  } else {
    preview.innerHTML = `<span>${initials(currentUser?.displayName || currentUser?.email)}</span>`;
  }
}

$("avatarPickBtn").addEventListener("click", () => $("avatarFileInput").click());
$("avatarFileInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  const errorEl = $("profileError");
  errorEl.hidden = true;
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    errorEl.textContent = "Please choose an image file.";
    errorEl.hidden = false;
    e.target.value = "";
    return;
  }
  if (file.size > MAX_AVATAR_BYTES) {
    errorEl.textContent = "Image is too large — please pick one under 5MB.";
    errorEl.hidden = false;
    e.target.value = "";
    return;
  }

  pendingAvatarFile = file;
  const reader = new FileReader();
  reader.onload = () => setAvatarPreview(reader.result);
  reader.readAsDataURL(file);
});

$("profileBio").addEventListener("input", (e) => {
  $("profileBioCount").textContent = `${MAX_BIO_LEN - e.target.value.length} left`;
});

$("profileForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentUser) return;

  const displayName = $("profileDisplayName").value.trim();
  const bio = $("profileBio").value.trim();
  const errorEl = $("profileError");
  errorEl.hidden = true;

  if (!displayName) {
    errorEl.textContent = "Display name can't be empty.";
    errorEl.hidden = false;
    return;
  }

  const saveBtn = $("profileSaveBtn");
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving...";

  try {
    let photoURL = currentUser.photoURL || null;

    if (pendingAvatarFile) {
      const avatarRef = ref(storage, `avatars/${currentUser.uid}/avatar`);
      await uploadBytes(avatarRef, pendingAvatarFile, { contentType: pendingAvatarFile.type });
      const rawUrl = await getDownloadURL(avatarRef);
      // cache-bust so the browser fetches the new image immediately
      photoURL = `${rawUrl}&cb=${Date.now()}`;
    }

    await updateProfile(currentUser, { displayName, photoURL });
    await setDoc(doc(db, "users", currentUser.uid), {
      displayName, photoURL: photoURL || null, bio,
      updatedAt: serverTimestamp()
    }, { merge: true });

    // updateProfile mutates auth.currentUser in place; keep local references in sync
    currentUser = auth.currentUser;
    currentUserProfile.bio = bio;
    pendingAvatarFile = null;

    renderAuthArea();
    closeModal("profileOverlay");
    showToast("Profile updated.", "success");
  } catch (err) {
    errorEl.textContent = "Couldn't save your profile — try again in a moment.";
    errorEl.hidden = false;
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save profile";
  }
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

async function toggleLike(siteId) {
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
  } catch {
    showToast("Couldn't update your like — try again.", "error");
  }
}

async function visitSite(siteId, url) {
  updateDoc(doc(db, "sites", siteId), { viewCount: increment(1) }).catch(() => {});
  window.open(normalizeUrl(url), "_blank", "noopener");
}

async function deleteSite(siteId) {
  if (!confirm("Remove this listing from the board?")) return;
  try {
    await deleteDoc(doc(db, "sites", siteId));
    showToast("Listing removed.", "success");
  } catch {
    showToast("Couldn't remove that listing — try again.", "error");
  }
}

/* ---------- submit form ---------- */
const descInput = $("siteDescription");
descInput.addEventListener("input", () => {
  $("descCharCount").textContent = `${MAX_DESCRIPTION_LEN - descInput.value.length} left`;
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
  try {
    url = normalizeUrl(rawUrl);
    new URL(url);
  } catch {
    errorEl.textContent = "That URL doesn't look valid.";
    errorEl.hidden = false;
    return;
  }

  const submitBtn = $("submitSiteBtn");
  submitBtn.disabled = true;
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
    $("descCharCount").textContent = `${MAX_DESCRIPTION_LEN} left`;
    closeModal("submitOverlay");
    showToast("Listed on the board.", "success");
  } catch {
    errorEl.textContent = "Couldn't submit that — try again in a moment.";
    errorEl.hidden = false;
  } finally {
    submitBtn.disabled = false;
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
}, () => {
  $("boardLoading").textContent = "Couldn't load the board — check your connection and refresh.";
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

  const stillLoading = !$("boardLoading").hidden;
  $("boardEmpty").hidden = list.length !== 0 || stillLoading;
  grid.innerHTML = list.map(cardHTML).join("");

  grid.querySelectorAll("[data-visit]").forEach((el) => {
    el.addEventListener("click", (e) => { e.preventDefault(); visitSite(el.dataset.visit, el.dataset.url); });
  });
  grid.querySelectorAll("[data-like]").forEach((el) => {
    el.addEventListener("click", () => toggleLike(el.dataset.like));
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
        <button class="like-btn${liked ? " liked" : ""}" type="button" data-like="${site.id}">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="${liked ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M8 14s-6-3.6-6-8.1C2 3.5 3.7 2 5.7 2 6.8 2 7.6 2.6 8 3.4 8.4 2.6 9.2 2 10.3 2c2 0 3.7 1.5 3.7 3.9C14 10.4 8 14 8 14z"/></svg>
          <span>${site.likeCount || 0}</span>
        </button>
        <span class="view-count">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></svg>
          ${site.viewCount || 0}
        </span>
        <a class="visit-btn" href="${escapeHTML(normalizeUrl(site.url))}" data-visit="${site.id}" data-url="${escapeHTML(site.url)}" target="_blank" rel="noopener">Visit →</a>
      </div>
    </article>
  `;
}

/* ---------- browse controls ---------- */
$("searchInput").addEventListener("input", debounce((e) => {
  searchTerm = e.target.value;
  renderGrid();
}, 150));

$("sortSelect").addEventListener("change", (e) => {
  currentSort = e.target.value;
  renderGrid();
});

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
