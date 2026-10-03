# Firebase signaling (optional)

MONSTER-X works with **zero configuration**: by default it uses the free public PeerJS broker
only to exchange the WebRTC handshake, and all gameplay runs over a direct peer-to-peer
DataChannel. Firebase Realtime Database is an optional, more controllable signaling backend.
Turn it on when you want your own quota, your own uptime, or room codes that live in a
database you own.

Firebase is used **only** for room creation, room codes, SDP offers/answers, ICE candidates and
room status. No gameplay traffic goes through it, so the Spark (free) plan is plenty. The SDK is
loaded with a dynamic `import()` only when Firebase is configured, so it never adds weight to
the default build (Vite puts it in a separate lazy `firebase` chunk).

Client code: `src/network/signaling-firebase.js`. Rules: `firebase/database.rules.json`.

---

## Console setup (about 5 minutes)

1. **Create a project.** Go to <https://console.firebase.google.com>, click *Add project*, pick
   a name. Google Analytics is not needed.
2. **Add a Web app.** On the project overview click the `</>` (Web) icon, register an app (no
   Firebase Hosting needed) and copy the `firebaseConfig` values:

   | firebaseConfig  | Environment variable          |
   | --------------- | ----------------------------- |
   | `apiKey`        | `VITE_FIREBASE_API_KEY`       |
   | `authDomain`    | `VITE_FIREBASE_AUTH_DOMAIN`   |
   | `databaseURL`   | `VITE_FIREBASE_DATABASE_URL`  |
   | `projectId`     | `VITE_FIREBASE_PROJECT_ID`    |
   | `appId`         | `VITE_FIREBASE_APP_ID`        |

   `databaseURL` only appears after step 4. It looks like
   `https://<project>-default-rtdb.firebaseio.com` (us-central1) or
   `https://<project>-default-rtdb.<region>.firebasedatabase.app`.
3. **Enable Anonymous sign-in.** *Build -> Authentication -> Get started -> Sign-in method ->
   Anonymous -> Enable*. Every player silently gets an anonymous uid; the rules use it to
   decide who owns a room and who holds the guest slot. (Anonymous sign-in does not use the
   *Authorized domains* list, so no domain setup is needed for it.)
4. **Create the Realtime Database.** *Build -> Realtime Database -> Create database*, pick the
   region closest to your players, start in **locked mode**.
5. **Paste the rules.** Open the *Rules* tab, replace everything with the contents of
   `firebase/database.rules.json` and click *Publish*. You can try requests in the *Rules
   Playground* on the same tab (choose *Authenticated*, provider *Anonymous*).
   With the Firebase CLI instead: put `{ "database": { "rules": "firebase/database.rules.json" } }`
   in a `firebase.json` at the repo root and run `firebase deploy --only database`.
6. **Configure the build.** Put the five values in `.env.local` for local development (see
   `.env.example`), or add them as repository variables or secrets for GitHub Pages; the
   deploy workflow passes them to `npm run build`. Restart `npm run dev` after changing env
   files.

The game picks Firebase automatically when `VITE_FIREBASE_API_KEY` and
`VITE_FIREBASE_DATABASE_URL` are set. `VITE_SIGNALING=peerjs`, or `?signaling=peerjs` in the
URL, forces PeerJS anyway.

### What is safe to expose

The Firebase **web config is public by design**. It identifies your project; it does not
authorize anything. It ships inside every Firebase web app, and anyone can read it from the
bundle. Security comes from two things:

- the **Realtime Database rules** in this folder, which deny everything except the exact
  signaling operations below; and
- **Anonymous Authentication**, which gives every client a uid that the rules can bind
  ownership to.

That is why the values can be repository *variables* rather than secrets. Optional hardening:
in Google Cloud Console -> *APIs & Services -> Credentials*, restrict the browser API key with
HTTP referrers (`https://<user>.github.io/*`, `http://localhost:5173/*`) and consider Firebase
App Check. **Never** put a service-account key or the database secret in any `VITE_*` variable.

---

## Data model

```
rooms/{CODE}
  meta:    { hostUid, createdAt, expiresAt, status, v }   created by the host (transaction)
  guest:   { uid, joinedAt }                              the single guest slot (transaction)
  toHost/{pushId}:  { m: JSON string, t: ms }             guest -> host mailbox
  toGuest/{pushId}: { m: JSON string, t: ms }             host -> guest mailbox
```

`CODE` is 5 or 6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no O/0/I/1). Each side
listens with `onChildAdded` on its mailbox and deletes every message as soon as it has read it.

---

## The rules, group by group

Realtime Database semantics shape everything below:

- A `.read` or `.write` that evaluates to true **cascades to every child**, and a deeper rule
  cannot take it back. Rules only ever add access.
- A write at path P is authorized only by `.write` rules **at P or above it**.
- `.validate` rules **do not cascade**. Every `.validate` on the written node, its descendants
  and its ancestors must pass, and none of them run on deletes.
- Rules are **not filters**. A read or query either passes as a whole or fails.

### Root: deny by default

`.read: false` and `.write: false` at the root. Nothing outside `rooms/` is reachable.

### `rooms`: cleanup query only

```
.read: auth != null && query.orderByChild == 'meta/expiresAt'
       && query.endAt <= now && query.limitToFirst <= 25
.indexOn: ["meta/expiresAt"]
```

Nobody can list rooms. The only allowed read of the collection is the exact cleanup query from
`_cleanupExpired()`: `orderByChild('meta/expiresAt').endAt(Date.now()).limitToFirst(20)`. A
query must be ordered by expiry, may not look past the server's `now`, and is capped at 25
rows, so it can only ever return rooms that are **already expired**. Live rooms can't be
enumerated. The index lets the server run that query instead of downloading the whole
collection.

### `rooms/{CODE}` (room root): host power, expired-room cleanup

`.write` is granted in three cases, all requiring `auth != null` and a valid code:

1. **The host** (`data.meta.hostUid === auth.uid`). The host may change anything in its room or
   delete it (`close()`, the `onDisconnect().remove()` registered in `host()`, removing
   consumed `toHost` messages, `releaseGuest()`, `setStatus()`, the 10-minute `expiresAt`
   refresh). Any non-delete write must keep `meta.hostUid === auth.uid`, so a host can't hand
   its room to someone else.
2. **Anyone, deleting an expired room** (`!newData.exists()` and `meta.expiresAt < now`). This is
   the `remove(child.ref)` in `_cleanupExpired()`. Partial edits of an expired room are not
   allowed, only removing the whole thing.
3. **Anyone, creating a pristine room** where none exists or the old one has expired: the new
   `meta.hostUid` must be the writer's uid, `meta.expiresAt` must be in the future, and the
   write may not contain `guest`, `toHost` or `toGuest`. In practice the meta transaction below
   is what creates rooms.

Because a grant here cascades, it is deliberately **never granted to guests**. Guests get
narrower rules on `guest`, `toHost` and `toGuest` only.

`.validate` checks the code and requires `meta` to exist in the result, so a room can't be
orphaned by deleting `meta` while other children remain. `$other: false` rejects any room child
other than `meta`, `guest`, `toHost` and `toGuest`.

> **Regex note:** Realtime Database regexes do not support `{n,m}` quantifiers, so
> `/^[A-HJ-NP-Z2-9]{5,6}$/` is written as five copies of the character class plus an optional
> sixth: `/^[A-HJ-NP-Z2-9][A-HJ-NP-Z2-9][A-HJ-NP-Z2-9][A-HJ-NP-Z2-9][A-HJ-NP-Z2-9][A-HJ-NP-Z2-9]?$/`.
> It matches exactly the same strings.

### `meta`: readable by any player, writable by the host

- `.read: auth != null`: any signed-in client can check that a code exists before joining
  (`join()` calls `get(meta)`). `runTransaction()` also needs read access, because the SDK
  watches the node while the transaction runs.
- `.write`: the new `hostUid` must be the writer, **and** either meta does not exist yet, the
  writer already owns it, or it has expired (`expiresAt < now`). This is the `host()`
  transaction. The client aborts on a live room and reports `ID_TAKEN`, and the server enforces
  the same thing. Meta can never be deleted on its own; deleting the room root is the only way.
- `.validate`: all five fields are required. `hostUid` is a non-empty string, `createdAt` and `v`
  are numbers, `status` is a short string (`open`, `playing`), and `expiresAt` is a number
  **<= now + 3,700,000 ms**. That is the 60-minute TTL plus 100 s of clock-skew slack, so no
  room can claim a code for longer than about an hour without refreshing. Unknown fields are
  rejected.

### `guest`: one slot, first come first served

- `.read: auth != null`: needed by the `join()` transaction. Seeing the current occupant lets
  the client abort cleanly with `ROOM_FULL`. The slot holds only an anonymous uid and a
  timestamp.
- `.write` allows exactly two things:
  - **claim or refresh**: `newData.uid === auth.uid`, the slot is empty or already yours, and
    the room's meta exists and has not expired. A third player can't take an occupied slot or
    join a dead room.
  - **leave**: delete, if the slot is yours (`close()` and the guest's `onDisconnect().remove()`).

  The host can also delete the slot through its room-level grant (`releaseGuest()`).
- `.validate`: `{ uid, joinedAt }` only. `uid` must equal the writer's uid, so nobody, not even
  the host, can put someone else's uid in the slot.

### `toHost`: guest -> host mailbox

- `.read`: only the host. This covers its `onChildAdded` listener.
- `$msg/.write`: **create-only** (`!data.exists()`), and only by the uid currently in the guest
  slot. The guest can't edit or delete messages, and nobody else can post. Once the guest
  leaves or is released, its writes stop working immediately.
- Deletion of consumed messages is done by the host, through its room-level grant.

### `toGuest`: host -> guest mailbox

- `.read`: only the uid in the guest slot. This covers its `onChildAdded` listener.
- Writes come from the host, through its room-level grant.
- `$msg/.write`: the guest may only **delete** existing messages, meaning the ones it has read.

### Message validation (both mailboxes)

Each message is `{ m, t }`: `m` is a string **shorter than 12,000 characters** (a JSON-encoded
SDP offer/answer is usually 1-5 KB), `t` is a number, the push key is at most 32 characters, and
any other field is rejected.

### Who can do what

For an existing, live room:

| Operation (signaling-firebase.js)       | Host | Guest (slot owner) | Other signed-in        | Signed out |
| --------------------------------------- | :--: | :----------------: | :--------------------: | :--------: |
| read `meta` (code check, transactions)   | yes  | yes                | yes                    | no         |
| update `meta` (`expiresAt`, `status`)    | yes  | no                 | no                     | no         |
| read `guest`                             | yes  | yes                | yes                    | no         |
| claim `guest`                            | n/a  | refresh own claim  | only if the slot is empty | no      |
| delete `guest`                           | yes  | yes (own slot)     | no                     | no         |
| push to `toHost`                         | yes  | yes                | no                     | no         |
| read / delete `toHost`                   | yes  | no                 | no                     | no         |
| push to `toGuest`                        | yes  | no                 | no                     | no         |
| read `toGuest`                           | no   | yes                | no                     | no         |
| delete `toGuest` messages                | yes  | yes                | no                     | no         |
| delete the room                          | yes  | no                 | no                     | no         |

Creating `meta` on a free or expired code is open to any signed-in player, who becomes that
room's host. Deleting a room, and the cleanup query on `rooms`, are open to any signed-in
player only once the room has **expired**.

Tip: two tabs of the **same browser** share one anonymous uid, so a local host + guest test
runs as a single uid. The rules allow that, since it is the same person.

---

## Cleanup: no scheduled job needed

Three mechanisms keep the database from filling up:

1. **`onDisconnect().remove()`**: the server deletes the whole room the moment the host's
   connection drops (tab closed, crash, network loss), and the guest slot when the guest's
   connection drops.
2. **`expiresAt`**: every room carries a 60-minute expiry that the host refreshes every
   10 minutes while it is open. Rules cap it at roughly one hour ahead, and an expired code can
   be reclaimed by a new host.
3. **Client cleanup**: whenever someone hosts, `_cleanupExpired()` deletes up to 20 expired
   rooms through the restricted query above. It is best-effort: a client whose clock runs
   ahead of the server's has its query denied (`endAt` must be `<= now`) and simply skips it.

Leftover rooms are therefore rare and short-lived. If you want a guarantee anyway, add a
scheduled Cloud Function (Blaze plan) that runs every hour, queries
`rooms.orderByChild('meta/expiresAt').endAt(Date.now())` with admin credentials and deletes the
results. The `.indexOn` above already covers that query.

Privacy note: mailbox messages contain ICE candidates, which include players' IP addresses.
Live mailboxes are readable only by the two players, and each side deletes messages as soon as
it reads them. The cleanup query can read whatever is left in a room once that room has
expired.
