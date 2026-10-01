import { detectExternalLinkService, type ExternalLinkService } from '@pcu/contracts';
import youtube from '../../assets/external-link-logos/youtube.svg';
import googleDrive from '../../assets/external-link-logos/google-drive.svg';
import github from '../../assets/external-link-logos/github.svg';
import itchIo from '../../assets/external-link-logos/itch-io.svg';
import steam from '../../assets/external-link-logos/steam.svg';
import notion from '../../assets/external-link-logos/notion.svg';
import discord from '../../assets/external-link-logos/discord.svg';

const logos = { youtube, 'google-drive': googleDrive, github, 'itch-io': itchIo, steam, notion, discord } satisfies Record<ExternalLinkService, string>;

/** Bundled, decorative artwork: the link's original label supplies its accessible name. */
export function ExternalLinkIcon({ url, service }: { url: string; service?: ExternalLinkService | null }) {
	const detected = service ?? detectExternalLinkService(url);
	const logo = detected ? logos[detected] : undefined;
	return logo
		? <img className="external-link-icon" src={logo} alt="" aria-hidden="true" data-service={detected} />
		: <svg className="external-link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" focusable="false" data-service="generic"><path d="m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 3 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" /></svg>;
}
