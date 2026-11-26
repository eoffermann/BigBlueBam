import { describe, it, expect, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { RichTextEditor } from '../src/components/common/rich-text-editor';

afterEach(() => cleanup());

function Controlled({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <RichTextEditor value={value} onChange={setValue} placeholder="Describe your issue" />;
}

function AsyncLoaded() {
  const [value, setValue] = useState('');
  return (
    <>
      <button type="button" onClick={() => setValue('Loaded **body**')}>
        load
      </button>
      <RichTextEditor value={value} onChange={setValue} placeholder="Describe your issue" />
    </>
  );
}

describe('RichTextEditor', () => {
  it('stays editable after the first keystroke into an empty editor', () => {
    render(<Controlled />);
    fireEvent.change(screen.getByPlaceholderText('Describe your issue'), {
      target: { value: 'H' },
    });
    const ta = screen.getByPlaceholderText('Describe your issue') as HTMLTextAreaElement;
    expect(ta.value).toBe('H');
    fireEvent.change(ta, { target: { value: 'Hello' } });
    expect((screen.getByPlaceholderText('Describe your issue') as HTMLTextAreaElement).value).toBe(
      'Hello',
    );
  });

  it('opens in preview when mounted with existing content', () => {
    render(<Controlled initial="Existing" />);
    expect(screen.queryByPlaceholderText('Describe your issue')).toBeNull();
    expect(screen.getByText('Existing')).toBeInTheDocument();
  });

  it('switches to preview when content arrives from outside before any edit', () => {
    render(<AsyncLoaded />);
    expect(screen.getByPlaceholderText('Describe your issue')).toBeInTheDocument();
    fireEvent.click(screen.getByText('load'));
    expect(screen.queryByPlaceholderText('Describe your issue')).toBeNull();
  });
});
