export type ResponsiveImage = {
	original: {
		url: string;
		width?: number;
		height?: number;
	};
	renditions: Array<{
		profile: 'CARD_480' | 'DISPLAY_960';
		url: string;
		width: number;
		height: number;
	}>;
};
