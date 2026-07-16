export interface RemoteFile {
	relativePath: string;
	mtimeMs: number;
	size: number;
	hash: string;
}

export interface SyncProvider {
	readonly kind: string;

	ensureReady(): Promise<void>;

	pull(): Promise<void>;

	listRemote(): Promise<RemoteFile[]>;

	/** Resolve a session-file relative path to the absolute path in the mirror. */
	mirrorPath(relativePath: string): string;

	/** Absolute path to the root of the mirror directory. */
	rootDir(): string;

	stageFromLocal(relativePath: string, localAbsolutePath: string): Promise<void>;

	push(message: string): Promise<void>;
}
