type Request = { redirectPath: string | undefined };

let request = $state<Request | null>(null);

export const signInChooser = {
	get open() {
		return request !== null;
	},
	get redirectPath() {
		return request?.redirectPath;
	},
	close() {
		request = null;
	},
};

export function chooseSignIn(redirectPath: string | undefined) {
	request = { redirectPath };
}
