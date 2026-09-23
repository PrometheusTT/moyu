# Make a Moyu Cartridge

[Back to contributing](../CONTRIBUTING.en.md) · [Full API reference (Chinese)](./cartridge-api.md)

A Cartridge is a local JavaScript game. Create a `my-game` directory with two files:

```text
my-game/
├── moyu.game.json
└── index.mjs
```

`moyu.game.json`:

```json
{
  "id": "my-game",
  "name": "My Game",
  "version": "1.0.0",
  "apiVersion": 1,
  "author": "you",
  "description": "A tiny terminal game",
  "entry": "index.mjs",
  "viewport": { "width": 64, "height": 40 },
  "display": { "micro": false, "minRows": 6 },
  "palette": ["#0c0d12", "#ecf0f8"],
  "controls": [{ "action": "move", "label": "Move", "keys": ["A/D"] }]
}
```

`index.mjs`:

```js
export default {
  create() {
    let x = 20;
    return {
      update(dt, input) {
        if (input.left) x -= 24 * dt;
        if (input.right) x += 24 * dt;
        x = Math.max(0, Math.min(61, x));
      },
      render(canvas) {
        canvas.clear(0);
        canvas.rect(Math.round(x), canvas.height - 6, 3, 5, 1);
      }
    };
  }
};
```

Install and play locally:

```sh
moyu games add ./my-game
moyu games add ./my-game --yes
moyu play my-game
```

The first `add` previews the trusted-code warning; `--yes` confirms it. Cartridges run as the current user, with access to that user's files and network. Review code before installing someone else's game. For input, save data, responsive rendering, and host events, see the [full API reference](./cartridge-api.md) and [TypeScript types](../src/platform/types.ts).
