import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import {
	Mesh,
	MeshBasicMaterial,
	MeshStandardMaterial,
	type Object3D,
} from "three";
import { loadModel } from "$lib/model3d/load";
import { disposeModel } from "$lib/model3d/studio";

const bytes = readFileSync(
	new URL("./fixtures/model3d-materials.glb", import.meta.url),
);

async function loadFixture(t: TestContext) {
	const model = await loadModel({
		format: "glb",
		bytes,
		resolveReference: async (reference) => {
			throw new Error(`Unexpected external resource: ${reference}`);
		},
	});
	t.after(() => disposeModel(model.root));
	assert.deepEqual(model.missing, []);
	return model.root;
}

function mesh(root: Object3D, name: string) {
	const object = root.getObjectByName(name);
	assert.ok(object instanceof Mesh);
	return object;
}

function standardMaterial(root: Object3D, name: string) {
	const material = mesh(root, name).material;
	assert.ok(material instanceof MeshStandardMaterial);
	return material;
}

test("GLB primitives without materials use the neutral preview surface", async (t) => {
	const root = await loadFixture(t);
	const material = standardMaterial(root, "neutral");
	assert.equal(material.color.getHex(), 0x9aa0a8);
	assert.equal(material.roughness, 0.62);
	assert.equal(material.metalness, 0.04);
	assert.equal(material.wireframe, false);
	assert.equal(material.flatShading, false);
	assert.equal(material.vertexColors, false);
	assert.equal(material.opacity, 1);
});

test("GLB neutral surfaces retain flat shading when normals are absent", async (t) => {
	const root = await loadFixture(t);
	const material = standardMaterial(root, "neutral-flat");
	assert.equal(material.color.getHex(), 0x9aa0a8);
	assert.equal(material.flatShading, true);
	assert.equal(mesh(root, "neutral-flat").geometry.hasAttribute("normal"), false);
});

test("GLB neutral surfaces preserve untinted vertex colors", async (t) => {
	const root = await loadFixture(t);
	const material = standardMaterial(root, "neutral-colored");
	assert.equal(material.color.getHex(), 0xffffff);
	assert.equal(material.vertexColors, true);
	assert.equal(material.roughness, 0.62);
	assert.equal(material.metalness, 0.04);
	const color = mesh(root, "neutral-colored").geometry.getAttribute("color");
	assert.ok(Math.abs(color.getX(0) - 0.8) < 1e-6);
	assert.ok(Math.abs(color.getY(0) - 0.2) < 1e-6);
	assert.ok(Math.abs(color.getZ(0) - 0.1) < 1e-6);
});

test("GLB authored materials retain their color and surface properties", async (t) => {
	const root = await loadFixture(t);
	const authored = standardMaterial(root, "authored");
	assert.equal(authored.color.getHex(), 0xffffff);
	assert.equal(authored.roughness, 1);
	assert.equal(authored.metalness, 1);
	const transparent = standardMaterial(root, "transparent");
	assert.equal(transparent.color.getHex(), 0x3578ab);
	assert.equal(transparent.roughness, 0.31);
	assert.equal(transparent.metalness, 0.73);
	assert.equal(transparent.opacity, 0.4);
	assert.equal(transparent.transparent, true);
	const unlit = mesh(root, "unlit").material;
	assert.ok(unlit instanceof MeshBasicMaterial);
	assert.equal(unlit.color.getHex(), 0x13ad6b);
});

test("GLB repeated primitives keep shared neutral materials", async (t) => {
	const root = await loadFixture(t);
	assert.equal(
		standardMaterial(root, "neutral"),
		standardMaterial(root, "neutral-shared"),
	);
});
