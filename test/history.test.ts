import { beforeEach, describe, expect, it, vi } from 'vitest';
import type EditorJS from '@editorjs/editorjs';
import { EditorUndoManager } from '../src/index';

const createEditorMock = () => {
    const blocks: EditorJS.OutputBlockData[] = [];
    return {
        blocks: {
            getCurrentBlockIndex: vi.fn().mockReturnValue(0),
            getBlockByIndex: vi.fn().mockReturnValue({ id: '1', type: 'paragraph', data: { text: 'Hello' } }),
        },
        configuration: {
            holder: 'editorjs',
        },
        caret: {
            setToBlock: vi.fn(),
        },
        save: vi.fn().mockResolvedValue({ blocks }),
        render: vi.fn().mockResolvedValue(undefined),
    } as unknown as EditorJS;
};

const createSelectionMock = () => ({
    rangeCount: 1,
    getRangeAt: () => ({
        cloneRange: () => ({
            selectNodeContents: vi.fn(),
            setEnd: vi.fn(),
            toString: () => 'Hello',
        }),
    }),
    removeAllRanges: vi.fn(),
    addRange: vi.fn(),
});

beforeEach(() => {
    const elementMock = {
        getElementsByClassName: vi.fn().mockReturnValue([
            { firstChild: { textContent: 'Hello' } },
        ]),
    } as unknown as HTMLElement;

    const documentMock = {
        getElementById: vi.fn().mockReturnValue(elementMock),
        createRange: () => ({
            setStart: vi.fn(),
            collapse: vi.fn(),
        }),
    } as unknown as Document;

    Object.defineProperty(global, 'document', {
        value: documentMock,
        configurable: true,
    });

    Object.defineProperty(global, 'window', {
        value: {
            getSelection: () => createSelectionMock(),
        },
        configurable: true,
    });
});

describe('EditorUndoManager', () => {
    it('initializes with initial data', () => {
        const editor = createEditorMock();
        const manager = new EditorUndoManager(editor);

        const updateSpy = vi.fn();
        manager['config'].onUpdate = updateSpy;

        manager.initialize({ blocks: [{ id: '1', type: 'paragraph', data: { text: 'First' } }] });

        expect(manager.getState()).toEqual({
            position: 0,
            count: 1,
            canUndo: false,
            canRedo: false,
        });
        expect(updateSpy).toHaveBeenCalled();
    });

    it('captures snapshots on change', async () => {
        const editor = createEditorMock();
        const manager = new EditorUndoManager(editor, { debounceMs: 0 });

        manager.initialize({ blocks: [{ id: '1', type: 'paragraph', data: { text: 'First' } }] });

        editor.save = vi.fn().mockResolvedValue({
            blocks: [
                { id: '1', type: 'paragraph', data: { text: 'First' } },
                { id: '2', type: 'paragraph', data: { text: 'Second' } },
            ],
        });

        await manager.handleEditorChange();

        expect(manager.getState()).toMatchObject({
            position: 1,
            count: 2,
            canUndo: true,
            canRedo: false,
        });
    });

    it('performs undo and redo', async () => {
        const editor = createEditorMock();
        const manager = new EditorUndoManager(editor, { debounceMs: 0 });

        manager.initialize({ blocks: [{ id: '1', type: 'paragraph', data: { text: 'First' } }] });

        editor.save = vi.fn().mockResolvedValue({
            blocks: [
                { id: '1', type: 'paragraph', data: { text: 'First' } },
                { id: '2', type: 'paragraph', data: { text: 'Second' } },
            ],
        });

        await manager.handleEditorChange();

        await manager.undo();
        expect(manager.getState()).toMatchObject({ position: 0, canUndo: false, canRedo: true });
        expect(editor.render).toHaveBeenCalledTimes(1);

        await manager.redo();
        expect(manager.getState()).toMatchObject({ position: 1, canUndo: true, canRedo: false });
    });
});


