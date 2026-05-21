// Inline contenteditable primitive. State drives the deploy artifact; the DOM
// owns the cursor; the two are kept in sync via a layout-effect.
//
// Design notes:
//   - We NEVER pass `value` as React children. React reconciles children on
//     every render — even with `suppressContentEditableWarning` — and switching
//     between modes (children-rendered preview vs no-children contenteditable)
//     was clearing the DOM text on the mode flip.
//   - Instead, useLayoutEffect imperatively sets `textContent` whenever value
//     or mode changes. The `textContent !== value` guard skips writes when the
//     DOM already matches, which preserves the caret during user typing.
//   - useLayoutEffect runs before the browser paints, so there's no flash of
//     empty content when transitioning between modes.

import {
    createElement,
    useLayoutEffect,
    useRef,
    type CSSProperties,
    type FormEvent,
} from "react";

interface EditableProps {
    tag: keyof HTMLElementTagNameMap;
    value: string;
    onChange: (next: string) => void;
    /** When false, renders as a plain element with no editing affordances — the
     * exact same DOM the deploy artifact will contain. */
    editable: boolean;
    style?: CSSProperties;
    className?: string;
    placeholder?: string;
    ariaLabel?: string;
}

export function Editable({
    tag,
    value,
    onChange,
    editable,
    style,
    className,
    placeholder,
    ariaLabel,
}: EditableProps) {
    const ref = useRef<HTMLElement>(null);

    useLayoutEffect(() => {
        if (ref.current && ref.current.textContent !== value) {
            ref.current.textContent = value;
        }
    }, [value, editable]);

    const onInput = (e: FormEvent<HTMLElement>) => {
        onChange(e.currentTarget.textContent ?? "");
    };

    return createElement(tag, {
        ref,
        contentEditable: editable ? "plaintext-only" : undefined,
        suppressContentEditableWarning: editable || undefined,
        onInput: editable ? onInput : undefined,
        className: editable ? `editable ${className ?? ""}`.trim() : className,
        style,
        spellCheck: editable || undefined,
        "data-placeholder": editable ? placeholder : undefined,
        "aria-label": ariaLabel,
    });
}
