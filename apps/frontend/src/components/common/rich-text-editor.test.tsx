// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RichTextEditor } from './rich-text-editor';

// Pins the edit/preview mode contract — above all the regression where
// the auto-preview effect mistook the user's FIRST keystroke into an
// empty editor for an async value load and yanked the textarea away
// mid-word ("one character and they exit").
//
// This file is kept in lockstep with the byte-identical copy in
// apps/frontend/src/components/common/ — change both together.

function ControlledHost({
  initial = '',
  defaultPreview,
}: {
  initial?: string;
  defaultPreview?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return <RichTextEditor value={value} onChange={setValue} defaultPreview={defaultPreview} />;
}

afterEach(cleanup);

describe('RichTextEditor mode switching', () => {
  it('starts empty in edit mode and STAYS in edit mode while the user types', () => {
    render(<ControlledHost initial="" />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: 'H' } });
    fireEvent.change(textarea, { target: { value: 'He' } });
    fireEvent.change(textarea, { target: { value: 'Hello' } });

    // The regression flipped to preview after the first character.
    expect(screen.getByRole('textbox')).toBeTruthy();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Hello');
  });

  it('switches to preview when a non-empty value arrives from outside (async load)', () => {
    function AsyncHost() {
      const [value, setValue] = useState('');
      return (
        <>
          <button type="button" onClick={() => setValue('Loaded **from API**')}>
            load
          </button>
          <RichTextEditor value={value} onChange={setValue} />
        </>
      );
    }
    const { container } = render(<AsyncHost />);
    expect(screen.getByRole('textbox')).toBeTruthy(); // empty → edit mode

    fireEvent.click(screen.getByText('load'));

    // Value came from the parent, not the keyboard → preview takes over.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(container.querySelector('.rich-text-content')?.innerHTML).toContain(
      '<strong>from API</strong>',
    );
  });

  it('respects an explicit defaultPreview={false} even when content loads asynchronously', () => {
    function AsyncHost() {
      const [value, setValue] = useState('');
      return (
        <>
          <button type="button" onClick={() => setValue('Loaded')}>
            load
          </button>
          <RichTextEditor value={value} onChange={setValue} defaultPreview={false} />
        </>
      );
    }
    render(<AsyncHost />);
    fireEvent.click(screen.getByText('load'));
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('starts in preview when mounted with existing content', () => {
    const { container } = render(<ControlledHost initial="*CEO*" />);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(container.querySelector('.rich-text-content')?.innerHTML).toContain('<em>CEO</em>');
  });

  it('a toolbar action on an empty document does not kick the editor into preview', () => {
    render(<ControlledHost initial="" />);
    fireEvent.click(screen.getByLabelText('Bold')); // inserts **text**
    expect(screen.getByRole('textbox')).toBeTruthy();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('**text**');
  });

  it('clicking the rendered preview returns to edit mode', () => {
    const { container } = render(<ControlledHost initial="Some saved text" />);
    expect(screen.queryByRole('textbox')).toBeNull();

    fireEvent.click(container.querySelector('.rich-text-content')!);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Some saved text');
  });

  it('the eye button toggles edit → preview → edit', () => {
    render(<ControlledHost initial="" />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'draft' } });

    fireEvent.click(screen.getByLabelText('Switch to preview mode'));
    expect(screen.queryByRole('textbox')).toBeNull();

    fireEvent.click(screen.getByLabelText('Switch to edit mode'));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('draft');
  });
});
