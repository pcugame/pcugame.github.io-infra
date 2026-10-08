import type { ComponentProps } from 'react';
import { TextField, TextareaField } from '../../ui';

export function ProjectIntroductionFields({ title, summary, description, summaryLength, errors }: {
	title: Omit<ComponentProps<'input'>, 'type'>; summary: Omit<ComponentProps<'input'>, 'type'>; description: ComponentProps<'textarea'>;
	summaryLength: number; errors: { title?: string; summary?: string; description?: string };
}) {
	return <>
		<TextField id="studio-title" label={<>작품명 <span className="required-mark">*</span></>} aria-required="true" placeholder="작품의 이름을 입력하세요" {...title} error={errors.title} />
		<TextField label={<>한 줄 소개 <span className="submission-studio__optional">선택</span></>} placeholder="어떤 게임인지 한 문장으로 소개해주세요" maxLength={300} {...summary} error={errors.summary} hint={<><span>장르와 플레이 경험이 드러나면 좋아요.</span><span className="submission-studio__counter">{summaryLength} / 300</span></>} />
		<TextareaField label={<>상세 설명 <span className="submission-studio__optional">선택</span></>} rows={5} maxLength={5000} placeholder="게임의 세계관, 핵심 플레이, 조작 방법을 소개하세요." {...description} error={errors.description} />
	</>;
}
