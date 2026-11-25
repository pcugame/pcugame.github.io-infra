// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CheckboxField, SelectField, TextareaField, TextField } from '../components/ui';

afterEach(cleanup);

it('keeps help separate from the label and links it with existing descriptions', () => {
  render(<TextField label="응답 길이 제한" help="답변에 쓸 수 있는 최대 토큰 수입니다."
    hint="128 이상" error="값을 확인하세요." aria-describedby="external-note" />);
  const input = screen.getByRole('textbox', { name: '응답 길이 제한' });
  const tooltip = screen.getByRole('tooltip', { hidden: true });
  const ids = input.getAttribute('aria-describedby')!.split(' ');
  expect(ids).toContain('external-note');
  expect(ids).toContain(tooltip.id);
  expect(ids).toHaveLength(4);
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByRole('button', { name: '응답 길이 제한 도움말' }).closest('label')).toBeNull();
  expect(tooltip.hidden).toBe(true);
});

it('opens on hover, remains readable under the pointer, and dismisses with Escape or pointer exit', () => {
  render(<SelectField label="데이터 용도" help="학습·검증·시험 자료를 구분합니다."><option>미지정</option></SelectField>);
  const button = screen.getByRole('button', { name: '데이터 용도 도움말' });
  const tooltip = screen.getByRole('tooltip', { hidden: true });
  fireEvent.mouseEnter(button);
  expect(tooltip.hidden).toBe(false);
  fireEvent.mouseEnter(tooltip);
  expect(tooltip.hidden).toBe(false);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(tooltip.hidden).toBe(true);
  fireEvent.mouseEnter(button);
  fireEvent.mouseLeave(button.parentElement!);
  expect(tooltip.hidden).toBe(true);
});

it('supports keyboard focus and click without changing a readonly field or submitting the form', () => {
  const submit = vi.fn(event => event.preventDefault());
  render(<form onSubmit={submit}><TextareaField label="고정 평가 지침" help="비교 조건을 맞추기 위해 고정합니다." readOnly value="공통 기준" /></form>);
  const button = screen.getByRole('button', { name: '고정 평가 지침 도움말' });
  const tooltip = screen.getByRole('tooltip', { hidden: true });
  act(() => button.focus());
  expect(tooltip.hidden).toBe(false);
  fireEvent.keyDown(button, { key: 'Escape' });
  expect(tooltip.hidden).toBe(true);
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  expect(tooltip.hidden).toBe(false);
  act(() => button.blur());
  expect(tooltip.hidden).toBe(true);
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('공통 기준');
  expect(submit).not.toHaveBeenCalled();
});

it('opens by tap without toggling the checkbox and closes on an outside tap', () => {
  render(<CheckboxField label="최종 평가" help="설정을 확정한 뒤 선택하세요." />);
  const button = screen.getByRole('button', { name: '최종 평가 도움말' });
  fireEvent.pointerDown(button, { pointerType: 'touch' });
  fireEvent.click(button);
  expect(screen.getByRole('tooltip').hidden).toBe(false);
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  fireEvent.pointerDown(document.body, { pointerType: 'touch' });
  expect(screen.getByRole('tooltip', { hidden: true }).hidden).toBe(true);
});
