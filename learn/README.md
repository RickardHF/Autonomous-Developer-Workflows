# Workshop exercise browser

A self-paced, visual way through the setup and exercises for this repository. The landing page uses
the same circular progress nodes as the workshop views: repository setup feeds a curved split into
the two workshops. The branches are dotted and both workshops are locked until every setup step is
complete; once setup is complete, the branches become solid and either workshop can be opened.
Opening a workshop reveals its exercise tree, while opening setup shows the checklist sourced from the
repository [`README.md`](../README.md). Progress is saved in your browser, so you can close the tab
and pick up where you left off.

## Running it

The app reads the exercise Markdown files at runtime, so it needs to be served over HTTP —
opening `index.html` directly from disk (`file://`) will not work.

From the **repository root**:

```bash
python3 -m http.server 8000
```

then open <http://localhost:8000/learn/>.

Any static server works — `npx serve .` or the VS Code Live Server extension are fine too. There is
no build step, no `npm install`, and nothing to configure.

## GitHub Pages

The workshop is published at
<https://eficodedemoorg.github.io/Agent-Orchestration-and-Evaluation-Workshop/>.

Configure the repository under **Settings → Pages**:

1. Set **Source** to **Deploy from a branch**.
2. Select the `main` branch and the `/(root)` folder.
3. Save the Pages settings.

The root [`index.html`](../index.html) redirects to `/learn/`, while [`.nojekyll`](../.nojekyll)
keeps the repository content static. Publish the repository root rather than only `learn/`: the app
loads the root `README.md` and the files under `exercises/` at runtime.

## How it works

| Piece | What it does |
| --- | --- |
| `manifest.json` | Defines the README setup section and which exercises exist in each ordered workshop. |
| `js/markdown.js` | A small Markdown renderer. Turns `- [ ]` items into interactive, persistable steps. |
| `js/store.js` | Progress and theme persistence via `localStorage`, plus export/import. |
| `js/app.js` | Content loading, routing, the module dashboard, workshop trees, setup, and exercise views. |
| `js/confetti.js` | The completion celebration. Disabled under `prefers-reduced-motion`. |
| `js/badge.js` | The workshop completion badge: canvas rendering plus the download dialog. |
| `js/dom.js` | The `el()` element builder shared by `app.js` and `badge.js`. |

Titles, summaries, step counts and time estimates are all **derived from the Markdown at runtime** —
there is no copy of the exercise content in this folder. Editing a file in `/exercises` is enough;
nothing here needs regenerating. The setup module extracts the section configured in `manifest.json`
directly from the root README, so its instructions also have a single source of truth.

Checkboxes beneath a heading whose text begins with `Optional` are shown as optional tasks. They can
still be checked and are saved with the rest of the learner's progress, but they do not count toward
module, individual-workshop, or overall workshop completion. The optional section continues through nested headings and
ends at the next heading of the same or higher level.

Learners can use **Skip for now** on any unfinished workshop module. Skipped modules remain
incomplete and are marked **Resume** in the workshop and module navigation; completed checklist steps
are preserved. Modules with no required tasks use an explicit **Complete module** action instead.
Repository setup remains mandatory and cannot be skipped.

### Routes

| Route | View |
| --- | --- |
| `#/` | Module dashboard |
| `#/setup` | Pre-workflow setup checklist |
| `#/workshop/<workshop-id>` | A workshop's exercise tree; redirects to setup until the prerequisite is complete |
| `#/e/<exercise-id>` | An individual exercise; redirects to setup until the prerequisite is complete |

### Adding an exercise

Add the file to `/exercises`, then add one line to the relevant track in `manifest.json`:

```json
{ "id": "customization-06", "file": "exercises/GitHub Copilot Customization 101/06-my-exercise.md" }
```

Add `"image": "<basename>"` if you also drop a matching pair of images into `assets/img/`.

### Images

`assets/img/` holds resized derivatives of `exercises/images/` — the originals are ~2.6 MB each,
which is far too heavy for a web page. Regenerate them with:

```bash
for f in exercises/images/*.png; do
  b=$(basename "$f" .png)
  sips -s format jpeg -s formatOptions 62 -Z 360  "$f" --out "learn/assets/img/${b}-thumb.jpg"
  sips -s format jpeg -s formatOptions 68 -Z 1100 "$f" --out "learn/assets/img/${b}-hero.jpg"
done
```

## Progress data

Everything lives under the `agentic-workshop.progress` key in `localStorage`. It is per-browser and
per-device — there is no account and no server. Use **Export progress** in the **Progress** menu to
move it between machines.

The version-2 progress object stores checkbox state in `done` and the `complete` or `skipped` state
of modules in `modules`. Version-1 progress is migrated in place when it is loaded.

## Workshop badges

Completing every module in a workshop unlocks **Get your badge** — on the hand-off card of the module
that finishes the workshop, and on the workshop page itself from then on. It opens a dialog with a
1200x1200 PNG the learner can download and post wherever they like.

The badge is drawn directly onto a canvas (`js/badge.js`) rather than exported from SVG: an SVG
rasterised through an `Image` cannot reach the Eficode logo or the Google Fonts faces, whereas a
canvas draws with the fonts the page has already loaded. The preview element is the export element,
so the download always matches what is on screen. Its palette is fixed and light, independent of the
selected theme.

The optional name is typed into the dialog and used for that image only — it is never written to
`localStorage`, so the progress file is unchanged by this feature. The badge is a keepsake, not a
verifiable credential: there is no issuer, no registry and nothing to check it against.

The setup checklist is stored in the same progress file so export, import, and reset continue to cover
the complete experience. Its percentage is displayed separately and is intentionally excluded from
the workshop-wide progress bar and individual workshop totals. **Reset progress** in the
**Progress** menu clears setup and workshop completion after confirmation, returns to the landing
page, and preserves the selected theme.
