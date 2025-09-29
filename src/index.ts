import type EditorJS from '@editorjs/editorjs';

export type ShortcutDefinition = string | string[];

export interface ShortcutConfiguration {
    undo?: ShortcutDefinition[];
    redo?: ShortcutDefinition[];
}

export interface UndoConfig {
    debounceMs?: number;
    shortcuts?: ShortcutConfiguration;
    maxHistory?: number;
    onUpdate?: (state: UndoState) => void;
}

export interface UndoState {
    position: number;
    count: number;
    canUndo: boolean;
    canRedo: boolean;
}

interface HistoryItem {
    blocks: EditorJS.OutputBlockData[];
    caretBlockIndex: number | null;
    caretOffset: number | null;
}

type ShortcutConfigResolved = {
    undo: ShortcutDefinition[];
    redo: ShortcutDefinition[];
};

const DEFAULT_SHORTCUTS: ShortcutConfigResolved = {
    undo: ['CMD+Z', 'CTRL+Z'],
    redo: ['CMD+SHIFT+Z', 'CTRL+SHIFT+Z', 'CTRL+Y'],
};

type ResolvedUndoConfig = {
    debounceMs: number;
    maxHistory: number;
    shortcuts: ShortcutConfigResolved;
    onUpdate: (state: UndoState) => void;
};

type EditorWithConfiguration = EditorJS & {
    configuration?: {
        holder?: string | HTMLElement;
    };
    caret: {
        setToBlock: (index: number, position: 'start' | 'end') => void;
    };
};

export class EditorUndoManager {
    private readonly editor: EditorWithConfiguration;
    private readonly config: ResolvedUndoConfig;
    private readonly history: HistoryItem[] = [];
    private position = -1;
    private isSaving = false;
    private readonly debouncedSaver: () => Promise<void>;
    private pendingSave = false;

    public constructor(editor: EditorJS, config: UndoConfig = {}) {
        this.editor = editor as EditorWithConfiguration;

        this.config = {
            debounceMs: config.debounceMs ?? 250,
            maxHistory: config.maxHistory ?? 100,
            onUpdate: config.onUpdate ?? (() => null),
            shortcuts: {
                undo: this.resolveShortcuts(config.shortcuts?.undo, DEFAULT_SHORTCUTS.undo),
                redo: this.resolveShortcuts(config.shortcuts?.redo, DEFAULT_SHORTCUTS.redo),
            },
        };

        this.debouncedSaver = this.debounce(async () => {
            if (this.isSaving) {
                this.pendingSave = true;
                return;
            }

            await this.captureSnapshot();

            if (this.pendingSave) {
                this.pendingSave = false;
                await this.captureSnapshot();
            }
        }, this.config.debounceMs);
    }

    public initialize(initialData: EditorJS.OutputData | EditorJS.OutputBlockData[] | { blocks?: EditorJS.OutputBlockData[] }): void {
        const blocks = this.extractBlocks(initialData);
        this.history.length = 0;
        this.history.push({
            blocks: this.cloneBlocks(blocks),
            caretBlockIndex: null,
            caretOffset: null,
        });
        this.position = 0;
        this.notify();
    }

    public register(): void {
        document.addEventListener('keydown', this.handleKeyDown, true);
    }

    public unregister(): void {
        document.removeEventListener('keydown', this.handleKeyDown, true);
    }

    public async undo(): Promise<void> {
        if (!this.canUndo()) {
            return;
        }

        this.position -= 1;
        await this.restore(this.history[this.position]);
        this.notify();
    }

    public async redo(): Promise<void> {
        if (!this.canRedo()) {
            return;
        }

        this.position += 1;
        await this.restore(this.history[this.position]);
        this.notify();
    }

    public canUndo(): boolean {
        return this.position > 0;
    }

    public canRedo(): boolean {
        return this.position >= 0 && this.position < this.history.length - 1;
    }

    public getState(): UndoState {
        return {
            position: this.position,
            count: this.history.length,
            canUndo: this.canUndo(),
            canRedo: this.canRedo(),
        };
    }

    public async handleEditorChange(): Promise<void> {
        await this.debouncedSaver();
    }

    private handleKeyDown = (event: KeyboardEvent): void => {
        if (this.matches(event, this.config.shortcuts.undo)) {
            event.preventDefault();
            void this.undo();
            return;
        }

        if (this.matches(event, this.config.shortcuts.redo)) {
            event.preventDefault();
            void this.redo();
        }
    };

    private async captureSnapshot(): Promise<void> {
        this.isSaving = true;
        try {
            const output = await this.editor.save();
            const caret = this.getCaretPosition();

            if (this.hasChanged(output.blocks)) {
                this.trimHistory();
                this.history.push({
                    blocks: this.cloneBlocks(output.blocks),
                    caretBlockIndex: caret.blockIndex,
                    caretOffset: caret.offset,
                });
                this.position = this.history.length - 1;
                this.notify();
            }
        } finally {
            this.isSaving = false;
        }
    }

    private async restore(item: HistoryItem): Promise<void> {
        await this.editor.render({ blocks: this.cloneBlocks(item.blocks) });
        this.restoreCaret(item);
    }

    private getCaretPosition(): { blockIndex: number | null; offset: number | null } {
        try {
            const currentBlockIndex = this.editor.blocks.getCurrentBlockIndex();
            if (currentBlockIndex === undefined || currentBlockIndex === null) {
                return { blockIndex: null, offset: null };
            }

            const block = this.editor.blocks.getBlockByIndex(currentBlockIndex);
            if (!block) {
                return { blockIndex: null, offset: null };
            }

            const element = this.getHolderElement();
            if (!element) {
                return { blockIndex: currentBlockIndex, offset: null };
            }

            const content = element.getElementsByClassName('ce-block__content')[currentBlockIndex];
            if (!content || !content.firstChild) {
                return { blockIndex: currentBlockIndex, offset: null };
            }

            const selection = window.getSelection();
            if (!selection || selection.rangeCount === 0) {
                return { blockIndex: currentBlockIndex, offset: null };
            }

            const range = selection.getRangeAt(0);
            const preRange = range.cloneRange();
            preRange.selectNodeContents(content);
            preRange.setEnd(range.endContainer, range.endOffset);

            return {
                blockIndex: currentBlockIndex,
                offset: preRange.toString().length,
            };
        } catch (error) {
            console.warn('Unable to capture caret position', error);
            return { blockIndex: null, offset: null };
        }
    }

    private restoreCaret(item: HistoryItem): void {
        if (item.caretBlockIndex === null || item.caretOffset === null) {
            return;
        }

        const container = this.getHolderElement();
        if (!container) {
            return;
        }

        const blockContent = container.getElementsByClassName('ce-block__content')[item.caretBlockIndex];
        if (!blockContent) {
            return;
        }

        const textNode = blockContent.firstChild;
        if (!textNode) {
            return;
        }

        const selection = window.getSelection();
        if (!selection) {
            return;
        }

        const range = document.createRange();
        const offset = Math.min(item.caretOffset, textNode.textContent?.length ?? 0);

        range.setStart(textNode, offset);
        range.collapse(true);

        this.editor.caret.setToBlock(item.caretBlockIndex, 'end');
        selection.removeAllRanges();
        selection.addRange(range);
    }

    private hasChanged(blocks: EditorJS.OutputBlockData[]): boolean {
        const current = this.history[this.position]?.blocks ?? [];
        return JSON.stringify(current) !== JSON.stringify(blocks);
    }

    private trimHistory(): void {
        if (this.position < this.history.length - 1) {
            this.history.splice(this.position + 1);
        }

        if (this.history.length >= this.config.maxHistory) {
            this.history.splice(0, this.history.length - this.config.maxHistory + 1);
            this.position = this.history.length - 1;
        }
    }

    private notify(): void {
        this.config.onUpdate(this.getState());
    }

    private cloneBlocks(blocks: EditorJS.OutputBlockData[]): EditorJS.OutputBlockData[] {
        return JSON.parse(JSON.stringify(blocks ?? []));
    }

    private matches(event: KeyboardEvent, shortcuts: ShortcutDefinition[]): boolean {
        return shortcuts.some((shortcut) => this.matchesShortcut(event, shortcut));
    }

    private matchesShortcut(event: KeyboardEvent, shortcut: ShortcutDefinition): boolean {
        const combination = Array.isArray(shortcut) ? shortcut : shortcut.split('+');
        const normalized = combination.map((part) => part.trim().toLowerCase());
        const key = normalized.pop();

        if (!key) {
            return false;
        }

        const requiresCtrl = normalized.includes('ctrl') || normalized.includes('control');
        const requiresMeta = normalized.includes('cmd') || normalized.includes('meta');
        const requiresAlt = normalized.includes('alt');
        const requiresShift = normalized.includes('shift');

        if (requiresCtrl && !event.ctrlKey) {
            return false;
        }

        if (requiresMeta && !event.metaKey) {
            return false;
        }

        if (requiresAlt && !event.altKey) {
            return false;
        }

        if (requiresShift && !event.shiftKey) {
            return false;
        }

        if (!requiresCtrl && event.ctrlKey) {
            return false;
        }

        if (!requiresMeta && event.metaKey) {
            return false;
        }

        if (!requiresAlt && event.altKey) {
            return false;
        }

        if (!requiresShift && event.shiftKey) {
            return false;
        }

        return event.key.toLowerCase() === key;
    }

    private debounce<T extends (...args: unknown[]) => unknown>(fn: T, wait: number): (...funcArgs: Parameters<T>) => Promise<void> {
        let timeout: ReturnType<typeof setTimeout> | null = null;

        return async (...args: Parameters<T>) => {
            if (timeout) {
                clearTimeout(timeout);
            }

            await new Promise<void>((resolve) => {
                timeout = setTimeout(async () => {
                    timeout = null;
                    await fn(...args);
                    resolve();
                }, wait);
            });
        };
    }

    private extractBlocks(initialData: EditorJS.OutputData | EditorJS.OutputBlockData[] | { blocks?: EditorJS.OutputBlockData[] }): EditorJS.OutputBlockData[] {
        if (Array.isArray(initialData)) {
            return initialData;
        }

        if ('blocks' in initialData && Array.isArray(initialData.blocks)) {
            return initialData.blocks;
        }

        return [];
    }

    private getHolderElement(): HTMLElement | null {
        const holder = this.editor.configuration?.holder;

        if (!holder) {
            return null;
        }

        if (typeof holder === 'string') {
            return document.getElementById(holder);
        }

        return holder;
    }

    private resolveShortcuts(input: ShortcutDefinition[] | undefined, fallback: ShortcutDefinition[]): ShortcutDefinition[] {
        if (!input || input.length === 0) {
            return [...fallback];
        }

        return input.map((definition) => definition);
    }
}

export default EditorUndoManager;

declare global {
    interface Window {
        EditorUndoManager?: typeof EditorUndoManager;
    }
}

if (typeof window !== 'undefined') {
    window.EditorUndoManager = EditorUndoManager;
}

