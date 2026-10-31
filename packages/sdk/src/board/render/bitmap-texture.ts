import { ImageSource, Texture } from "pixi.js";

export class BoardBitmapTexture {
  private texture: Texture<ImageSource> | null = null;
  private bitmap: ImageBitmap | null = null;

  get current(): Texture | null { return this.texture; }

  update(bitmap: ImageBitmap, pixelated = false): void {
    const previous = this.bitmap;
    this.bitmap = bitmap;
    const scaleMode = pixelated ? "nearest" : "linear";
    if (!this.texture) {
      this.texture = new Texture({ source: new ImageSource({ resource: bitmap, scaleMode }), dynamic: true });
      return;
    }
    const source = this.texture.source;
    source.resource = bitmap;
    if (source.scaleMode !== scaleMode) source.scaleMode = scaleMode;
    source.update();
    if (previous !== bitmap) previous?.close();
  }

  destroy(): void {
    if (!this.texture) return;
    this.texture.destroy(true);
    this.bitmap?.close();
    this.bitmap = null;
    this.texture = null;
  }
}
