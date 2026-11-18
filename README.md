# Atlantis Gallery

The gallery shows 12 works per page. Each work page shows the creator and provides a copyable link, file downloads, and 3D controls. Relative URLs support both local preview and GitHub Pages project sites.

## Run locally and deploy

Run `python -m http.server 8080` from this directory and open `http://localhost:8080/`. The 3D viewer requires a browser with WebGPU support and a secure context. Localhost works for local previews. Three.js 0.186.0 ships with the site. Works that use Python load Pyodide 0.27.7 from jsDelivr on first use.

Commit the project directory to a public GitHub repository. Under Settings → Pages, select the main branch and the repository root. Work links use `work.html?model=<id>` and gallery pagination uses `?page=2`. Existing work links to the gallery home redirect to the detail page.

## Work data

Add each work to `catalog.json` with `id`, `title`, `creator`, `thumbnail`, `model`, and optional `description`, `interaction`, and `downloads` fields. Write titles, descriptions, download labels, and interaction labels in English. Use the creator's chosen display name. Downloads can link to an archive of the original USD and motion scripts, the modeling code for all parts, and the complete work-order JSON. Include external USD references and textures with their relative paths intact, or use USDZ.

Each work links to its GitHub discussion for upvotes and comments and to a gist for favorites. Visitors can find their saved assets under GitHub's **Starred gists** while signed in.

The owner’s MCP publisher creates both links for direct uploads. After merging a contributor’s pull request or adding a work by hand, run `python publisher/server.py --sync-social` from the Gallery checkout with the publisher dependencies installed and the Gallery owner's GitHub account signed in through Git Credential Manager. Commit and push the updated `social.json`. The command reuses links it created on any previous attempt.

Interaction files support the `atlantis-gallery-interactions/2` schema. Use full prim paths or unique names to bind parts. Define rotation and translation axes in local coordinates. Rotation uses radians and translation uses model units. Each button can bind a 3D part and trigger multiple actions. It also appears in the page controls.

```json
{
  "schema": "atlantis-gallery-interactions/2",
  "normalCreaseDegrees": 45,
  "joints": [
    { "id": "door", "node": "/Asset/Hinge", "kind": "rotation", "axis": [0, 1, 0], "limits": [0, 1.65] },
    { "id": "tray", "node": "/Asset/Tray", "kind": "spin", "axis": [0, 1, 0] }
  ],
  "buttons": [
    {
      "id": "open",
      "node": "/Asset/OpenButton",
      "label": "Open Door",
      "actions": [
        { "type": "set", "joint": "door", "value": 1.65 },
        { "type": "spin", "joint": "tray", "value": 0 },
        { "type": "emit", "event": "opened" }
      ]
    }
  ]
}
```

An `emit` action dispatches `atlantis:emit` on the model root and can pass input to the `logic.profile` declared in the interaction file. The built-in `microwave` profile runs the shared Isaac `microwave_logic.py` in a Web Worker. `logic.bindings` maps returned state to joint position, spin speed, or part visibility. Other devices can use declarative actions or a pure Python module and browser adapter added to the site. Isaac's PhysX constraints, `omni` and `pxr` runtime, and simulator lighting APIs run in the Isaac process.

## 3D import and rendering

Three.js imports USD, USDA, USDC, USDZ, and GLB/glTF while preserving the part hierarchy for interactions and picking. The importer splits and smooths normals at each mesh's face corners. The default crease angle is 45° and can be adjusted with `normalCreaseDegrees`. The USD path uses the original topology to identify smoothing regions and preserves face-varying, uniform, and constant normals. It smooths across UV seams while retaining UVs, material groups, and other vertex attributes.

`atlantis-renderer/` comes from the local Atlantis C `current/rendering` directory and reuses its sky, clouds, atmosphere, skylight, preintegrated IBL, direct sunlight, Disney Principled shading, glow, and bloom. The viewer uses a single 2048 × 2048 shadow map that updates with model pose, screen-space reflections for opaque objects, and FXAA. Imported geometry and materials are staged as an in-memory GLB. Downloads use the original files. For complex USD composition, certain material networks, and PhysX, the exporter needs to provide a browser-ready preview and interaction mapping.

## Atlantis sharing integration

Use the [Share a Model guide](https://zhxx1987.github.io/AtlantisGallery/publish.html) to connect the local Gallery MCP. The assistant prepares a `submission.json` from the final Atlantis export and calls `prepare_gallery_upload` to show the files that will become public. Once the creator approves that package, `publish_gallery_asset` uploads it using Git Credential Manager. The Gallery owner publishes directly. Other contributors submit from their own GitHub fork and receive a pull request and work URL. GitHub Pages serves the work URL after the pull request is merged and the site is rebuilt.

The MCP packages the USD or GLB and its dependencies, original motion scripts, modeling source, and an optional public work-order JSON. Only the explicitly listed files are packaged. Browser controls use the interaction schema documented above.
