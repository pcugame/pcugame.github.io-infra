/**
 * DB Seed / 데이터 이전 스크립트
 *
 * 사용법:
 *   # 테스트 데이터 + ADMIN 세션 생성 (기본)
 *   npx tsx prisma/seed.ts
 *
 *   # JSON 파일에서 실제 데이터 임포트
 *   npx tsx prisma/seed.ts --import data.json
 *
 * JSON 파일 형식:
 * {
 *   "years": [
 *     { "year": 2024, "title": "2024 졸업작품전" }
 *   ],
 *   "projects": [
 *     {
 *       "year": 2024,
 *       "title": "게임 제목",
 *       "summary": "한 줄 소개",
 *       "description": "상세 설명",
 *       "isIncomplete": true,
 *       "status": "PUBLISHED",
 *       "members": [
 *         { "name": "홍길동", "studentId": "20240001" }
 *       ]
 *     }
 *   ]
 * }
 */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { PrismaClient } from '../src/generated/prisma/client.js';

const prismaClientModule = (process.env.SEED_USE_DIST === 'true'
  ? await import('../dist/lib/prisma-client.js')
  : await import('../src/lib/prisma-client.js')) as unknown as {
    createPrismaClientForDatabase(databaseUrl: string): PrismaClient;
  };

if (process.env.NODE_ENV === 'production') {
  console.error('ERROR: seed must not run in production');
  process.exit(1);
}

const prisma = prismaClientModule.createPrismaClientForDatabase(requiredEnv('DATABASE_URL'));

// ── 테스트 ADMIN 유저 + 세션 생성 ─────────────────────

async function seedTestAdmin() {
  const user = await prisma.user.upsert({
    where: { googleSub: 'test-admin-sub' },
    update: {},
    create: {
      googleSub: 'test-admin-sub',
      email: 'admin@test.pcu.ac.kr',
      name: 'Test Admin',
      role: 'ADMIN',
    },
  });
  console.log('User:', user.id, user.email, `(${user.role})`);

  // 기존 세션 삭제 후 랜덤 토큰으로 재생성
  await prisma.authSession.deleteMany({ where: { userId: user.id } });
  const sessionId = randomUUID();
  const session = await prisma.authSession.create({
    data: {
      id: sessionId,
      userId: user.id,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30일
    },
  });
  console.log('Session:', session.id, '(30일 유효)');

  return { user, sessionId };
}

// ── 테스트 데이터 생성 ────────────────────────────────

async function seedTestData(creatorId: number) {
  const exhibition = await prisma.exhibition.upsert({
    where: { year_title: { year: 2026, title: '졸업작품 전시회' } },
    update: {},
    create: { year: 2026, title: '졸업작품 전시회', isModificationEnabled: true },
  });

  const existing = await prisma.project.findUnique({
    where: { project_exhibition_slug: { exhibitionId: exhibition.id, slug: 'test-project' } },
  });
  if (existing) {
    console.log('테스트 프로젝트가 이미 존재합니다. 건너뜁니다.');
    return;
  }

  const project = await prisma.project.create({
    data: {
      exhibitionId: exhibition.id,
      slug: 'test-project',
      title: '테스트 졸업작품',
      summary: '배포 검증용 테스트 프로젝트입니다.',
      description: '이것은 시스템이 정상 동작하는지 확인하기 위한 테스트 프로젝트입니다.',
      status: 'PUBLISHED',
      creatorId,
      members: {
        create: [
          { name: '홍길동', studentId: '20260001', sortOrder: 0 },
          { name: '김철수', studentId: '20260002', sortOrder: 1 },
        ],
      },
    },
  });
  console.log('테스트 프로젝트:', project.id, project.title);
}

// ── 통합 테스트 데이터 + S3 fixture 업로드 ─────────────────

const INTEGRATION_USERS = {
  student: {
    googleSub: 'dev-auth-user',
    email: 'student@test.pcu.ac.kr',
    name: 'Integration Student',
    role: 'USER' as const,
    studentId: '20260001',
  },
  operator: {
    googleSub: 'dev-auth-operator',
    email: 'operator@test.pcu.ac.kr',
    name: 'Integration Operator',
    role: 'OPERATOR' as const,
    studentId: null,
  },
  admin: {
    googleSub: 'dev-auth-admin',
    email: 'admin@test.pcu.ac.kr',
    name: 'Integration Admin',
    role: 'ADMIN' as const,
    studentId: null,
  },
  other: {
    googleSub: 'dev-auth-other-user',
    email: 'other@test.pcu.ac.kr',
    name: 'Integration Other Student',
    role: 'USER' as const,
    studentId: '20260099',
  },
};

const INTEGRATION_PROJECT_SLUGS = [
	'integration-public-asset',
	'integration-webgl-deployment',
	'integration-archived',
	'integration-student-owned',
	'integration-member-project',
	'integration-other-owned',
	'integration-incomplete',
	'integration-draft-project',
];

const INTEGRATION_EXHIBITIONS = [
  { year: 2026, title: 'Integration Upload Open' },
  { year: 2027, title: 'Integration Upload Closed' },
  { year: 2028, title: 'Integration Empty Exhibition' },
];

const ONE_BY_ONE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);
const TINY_MP4 = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
]);
const EMPTY_ZIP = Buffer.from([
  0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env for integration seed: ${name}`);
  return value;
}

function integrationS3Client(): S3Client {
  return new S3Client({
    endpoint: requiredEnv('S3_ENDPOINT'),
    region: process.env.S3_REGION || 'garage',
    credentials: {
      accessKeyId: requiredEnv('S3_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnv('S3_SECRET_ACCESS_KEY'),
    },
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
  });
}

async function uploadIntegrationObject(
  s3: S3Client,
  bucket: string,
  key: string,
  body: Buffer,
  contentType: string,
) {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    ContentLength: body.length,
	}));
}

type ReadyRepresentation = {
	role: 'ORIGINAL' | 'PLAYBACK' | 'CARD_480' | 'DISPLAY_960' | 'WEBGL_SOURCE';
	bucket: string;
	objectKey: string;
	mimeType: string;
	sizeBytes: bigint;
	width?: number;
	height?: number;
	state?: 'READY' | 'FAILED';
	error?: string;
};

/**
 * Integration data deliberately creates the same graph the workers commit:
 * Asset is the domain identity and every byte location lives exclusively on a
 * representation.  Keeping this helper here prevents the integration seed
 * from silently reintroducing pre-contract scalar object columns.
 */
async function createIntegrationAsset(input: {
	projectId?: number;
	exhibitionId?: number;
	kind: 'GAME' | 'VIDEO' | 'IMAGE' | 'POSTER' | 'WEBGL';
	originalName: string;
	representations: ReadyRepresentation[];
}) {
	return prisma.asset.create({
		data: {
			...(input.projectId != null ? { projectId: input.projectId } : {}),
			...(input.exhibitionId != null ? { exhibitionId: input.exhibitionId } : {}),
			kind: input.kind,
			status: 'READY',
			originalName: input.originalName,
			representations: {
				create: input.representations.map((representation) => ({
					...representation,
					state: representation.state ?? 'READY',
				})),
			},
		},
	});
}

async function upsertIntegrationUser(user: typeof INTEGRATION_USERS[keyof typeof INTEGRATION_USERS]) {
  return prisma.user.upsert({
    where: { googleSub: user.googleSub },
    update: {
      email: user.email,
      name: user.name,
      role: user.role,
      picture: '',
      studentId: user.studentId,
    },
    create: {
      googleSub: user.googleSub,
      email: user.email,
      name: user.name,
      role: user.role,
      picture: '',
      ...(user.studentId ? { studentId: user.studentId } : {}),
    },
  });
}

async function seedIntegrationData() {
  console.log('통합 테스트 데이터 초기화 중...\n');

  const publicBucket = process.env.S3_BUCKET_PUBLIC || 'pcu-public';
  const protectedBucket = process.env.S3_BUCKET_PROTECTED || 'pcu-protected';
  const s3 = integrationS3Client();
	await prisma.storageBucket.upsert({
		where: { bucket: protectedBucket },
		update: { visibility: 'PROTECTED' },
		create: { bucket: protectedBucket, visibility: 'PROTECTED' },
	});
	await prisma.storageBucket.upsert({
		where: { bucket: publicBucket },
		update: { visibility: 'PUBLIC' },
		create: { bucket: publicBucket, visibility: 'PUBLIC' },
	});

	// The integration seed is intentionally rerunnable after smoke/e2e traffic.
	// Upload sessions restrict project/exhibition deletion, so remove only the
	// sessions owned by this seed graph before replacing that graph atomically.
	await prisma.$transaction(async (tx) => {
		const exhibitions = await tx.exhibition.findMany({
			where: { OR: INTEGRATION_EXHIBITIONS.map((item) => ({ year: item.year, title: item.title })) },
			select: { id: true },
		});
		const exhibitionIds = exhibitions.map(({ id }) => id);
		const projects = await tx.project.findMany({
			where: {
				OR: [
					{ slug: { in: INTEGRATION_PROJECT_SLUGS } },
					...(exhibitionIds.length > 0 ? [{ exhibitionId: { in: exhibitionIds } }] : []),
				],
			},
			select: { id: true },
		});
		const projectIds = projects.map(({ id }) => id);
		if (projectIds.length > 0 || exhibitionIds.length > 0) {
			await tx.assetUploadSession.deleteMany({
				where: {
					OR: [
						...(projectIds.length > 0 ? [{ projectId: { in: projectIds } }] : []),
						...(exhibitionIds.length > 0 ? [{ exhibitionId: { in: exhibitionIds } }] : []),
					],
				},
			});
		}
		if (projectIds.length > 0) {
			await tx.project.deleteMany({ where: { id: { in: projectIds } } });
		}
		if (exhibitionIds.length > 0) {
			await tx.exhibition.deleteMany({ where: { id: { in: exhibitionIds } } });
		}
	});

  const [student, operator, admin, other] = await Promise.all([
    upsertIntegrationUser(INTEGRATION_USERS.student),
    upsertIntegrationUser(INTEGRATION_USERS.operator),
    upsertIntegrationUser(INTEGRATION_USERS.admin),
    upsertIntegrationUser(INTEGRATION_USERS.other),
  ]);

  await prisma.authSession.deleteMany({
    where: { userId: { in: [student.id, operator.id, admin.id, other.id] } },
  });

	await uploadIntegrationObject(s3, publicBucket, '.healthcheck', Buffer.from('ok'), 'text/plain');
	const projectPosterKeys = {
		original: 'public/images/integration/poster/original.png',
		card480: 'public/images/integration/poster/card-480.png',
		display960: 'public/images/integration/poster/display-960.png',
	} as const;
	const projectImageKeys = {
		original: 'public/images/integration/image/original.png',
		card480: 'public/images/integration/image/card-480.png',
		display960: 'public/images/integration/image/display-960.png',
	} as const;
	for (const key of [...Object.values(projectPosterKeys), ...Object.values(projectImageKeys)]) {
		await uploadIntegrationObject(s3, publicBucket, key, ONE_BY_ONE_PNG, 'image/png');
	}
	await uploadIntegrationObject(s3, protectedBucket, 'integration-video.mp4', TINY_MP4, 'video/mp4');
	await uploadIntegrationObject(s3, protectedBucket, 'integration-video-playback.mp4', TINY_MP4, 'video/mp4');
	await uploadIntegrationObject(s3, protectedBucket, 'integration-video-failed.mp4', TINY_MP4, 'video/mp4');
	await uploadIntegrationObject(s3, protectedBucket, 'integration-game.zip', EMPTY_ZIP, 'application/zip');
	await uploadIntegrationObject(s3, protectedBucket, 'integration-webgl-source.zip', EMPTY_ZIP, 'application/zip');
	await uploadIntegrationObject(s3, publicBucket, 'public/webgl/integration-fixture/index.html', Buffer.from('<!doctype html><title>integration webgl</title>'), 'text/html');
	await uploadIntegrationObject(s3, publicBucket, 'public/webgl/integration-fixture/Build/game.js', Buffer.from('console.log("integration webgl")'), 'application/javascript');

	const uploadOpen = await prisma.exhibition.create({
		data: {
			year: 2026,
			title: 'Integration Upload Open',
			isModificationEnabled: true,
			sortOrder: 0,
		},
	});
	const exhibitionPosterPrefix = `public/images/exhibitions/${uploadOpen.id}`;
	const exhibitionPosterKeys = {
		original: `${exhibitionPosterPrefix}/original/integration-seed-v1.png`,
		card480: `${exhibitionPosterPrefix}/card_480/integration-seed-v1.png`,
		display960: `${exhibitionPosterPrefix}/display_960/integration-seed-v1.png`,
	} as const;
	for (const key of Object.values(exhibitionPosterKeys)) {
		await uploadIntegrationObject(s3, publicBucket, key, ONE_BY_ONE_PNG, 'image/png');
	}
	const exhibitionPoster = await createIntegrationAsset({
		exhibitionId: uploadOpen.id,
		kind: 'POSTER',
		originalName: 'integration-exhibition-poster.png',
		representations: [
			{
				role: 'ORIGINAL', bucket: publicBucket, objectKey: exhibitionPosterKeys.original,
				mimeType: 'image/png', sizeBytes: BigInt(ONE_BY_ONE_PNG.length), width: 1, height: 1,
			},
			{
				role: 'CARD_480', bucket: publicBucket, objectKey: exhibitionPosterKeys.card480,
				mimeType: 'image/png', sizeBytes: BigInt(ONE_BY_ONE_PNG.length), width: 480, height: 480,
			},
			{
				role: 'DISPLAY_960', bucket: publicBucket, objectKey: exhibitionPosterKeys.display960,
				mimeType: 'image/png', sizeBytes: BigInt(ONE_BY_ONE_PNG.length), width: 960, height: 960,
			},
		],
	});
	await prisma.exhibition.update({
		where: { id: uploadOpen.id },
		data: { posterAssetId: exhibitionPoster.id },
	});
  const uploadClosed = await prisma.exhibition.create({
    data: {
      year: 2027,
      title: 'Integration Upload Closed',
      isModificationEnabled: false,
      sortOrder: 1,
    },
  });
  const emptyExhibition = await prisma.exhibition.create({
    data: {
      year: 2028,
      title: 'Integration Empty Exhibition',
      isModificationEnabled: true,
      sortOrder: 2,
    },
  });

  const publicProject = await prisma.project.create({
    data: {
      exhibitionId: uploadOpen.id,
      slug: 'integration-public-asset',
      title: 'Integration Public Asset Project',
      summary: 'Public project with poster, image, video, and game fixtures.',
      description: 'Seeded for full-stack integration verification.',
      status: 'PUBLISHED',
      creatorId: student.id,
      members: {
        create: [{ name: student.name, studentId: student.studentId ?? '', userId: student.id, sortOrder: 0 }],
      },
    },
  });

	const poster = await createIntegrationAsset({
		projectId: publicProject.id,
		kind: 'POSTER',
		originalName: 'integration-poster.png',
		representations: [
			{ role: 'ORIGINAL', bucket: publicBucket, objectKey: projectPosterKeys.original, mimeType: 'image/png', sizeBytes: BigInt(ONE_BY_ONE_PNG.length), width: 1, height: 1 },
			{ role: 'CARD_480', bucket: publicBucket, objectKey: projectPosterKeys.card480, mimeType: 'image/png', sizeBytes: BigInt(ONE_BY_ONE_PNG.length), width: 480, height: 480 },
			{ role: 'DISPLAY_960', bucket: publicBucket, objectKey: projectPosterKeys.display960, mimeType: 'image/png', sizeBytes: BigInt(ONE_BY_ONE_PNG.length), width: 960, height: 960 },
		],
	});
  await prisma.project.update({
    where: { id: publicProject.id },
    data: { posterAssetId: poster.id },
  });
	await createIntegrationAsset({
		projectId: publicProject.id,
		kind: 'IMAGE',
		originalName: 'integration-image.png',
		representations: [
			{ role: 'ORIGINAL', bucket: publicBucket, objectKey: projectImageKeys.original, mimeType: 'image/png', sizeBytes: BigInt(ONE_BY_ONE_PNG.length), width: 1, height: 1 },
			{ role: 'CARD_480', bucket: publicBucket, objectKey: projectImageKeys.card480, mimeType: 'image/png', sizeBytes: BigInt(ONE_BY_ONE_PNG.length), width: 480, height: 480 },
			{ role: 'DISPLAY_960', bucket: publicBucket, objectKey: projectImageKeys.display960, mimeType: 'image/png', sizeBytes: BigInt(ONE_BY_ONE_PNG.length), width: 960, height: 960 },
		],
	});
	await createIntegrationAsset({
		projectId: publicProject.id,
		kind: 'VIDEO',
		originalName: 'integration-video.mp4',
		representations: [
			{ role: 'ORIGINAL', bucket: protectedBucket, objectKey: 'integration-video.mp4', mimeType: 'video/mp4', sizeBytes: BigInt(TINY_MP4.length) },
			{ role: 'PLAYBACK', bucket: protectedBucket, objectKey: 'integration-video-playback.mp4', mimeType: 'video/mp4', sizeBytes: BigInt(TINY_MP4.length) },
		],
	});
	await createIntegrationAsset({
		projectId: publicProject.id,
		kind: 'VIDEO',
		originalName: 'integration-video-failed.mp4',
		representations: [
			{ role: 'ORIGINAL', bucket: protectedBucket, objectKey: 'integration-video-failed.mp4', mimeType: 'video/mp4', sizeBytes: BigInt(TINY_MP4.length) },
			{ role: 'PLAYBACK', bucket: protectedBucket, objectKey: 'integration-video-failed-playback.mp4', mimeType: 'video/mp4', sizeBytes: 0n, state: 'FAILED', error: 'integration fixture: transcode failed' },
		],
	});
	await createIntegrationAsset({
		projectId: publicProject.id,
		kind: 'GAME',
		originalName: 'integration-game.zip',
		representations: [{
			role: 'ORIGINAL', bucket: protectedBucket, objectKey: 'integration-game.zip',
			mimeType: 'application/zip', sizeBytes: BigInt(EMPTY_ZIP.length),
		}],
	});

	await prisma.project.createMany({
		data: [
      {
        exhibitionId: uploadOpen.id,
        slug: 'integration-archived',
        title: 'Integration Archived Project',
        summary: 'Archived project visible in public archive flows.',
        status: 'ARCHIVED',
        creatorId: student.id,
      },
      {
        exhibitionId: uploadOpen.id,
        slug: 'integration-student-owned',
        title: 'Integration Student Owned Project',
        summary: 'Owned by the fixed USER account.',
        status: 'PUBLISHED',
        creatorId: student.id,
      },
      {
        exhibitionId: uploadOpen.id,
        slug: 'integration-other-owned',
        title: 'Integration Other Owned Project',
        summary: 'Owned by another student for permission checks.',
        status: 'PUBLISHED',
        creatorId: other.id,
      },
			{
				exhibitionId: uploadClosed.id,
        slug: 'integration-incomplete',
        title: 'Integration Incomplete Project',
        summary: 'Incomplete project in upload-disabled exhibition.',
        isIncomplete: true,
        status: 'PUBLISHED',
        creatorId: student.id,
			},
			{
				exhibitionId: uploadOpen.id,
				slug: 'integration-draft-project',
				title: 'Integration Draft Project',
				summary: 'Draft project intentionally excluded from public reads.',
				status: 'DRAFT',
				creatorId: student.id,
			},
		],
	});

	const webglProject = await prisma.project.create({
		data: {
			exhibitionId: uploadOpen.id,
			slug: 'integration-webgl-deployment',
			title: 'Integration Immutable WebGL Deployment',
			summary: 'Published canonical WebGL deployment fixture.',
			status: 'PUBLISHED',
			creatorId: student.id,
		},
	});
	const webglSource = await createIntegrationAsset({
		projectId: webglProject.id,
		kind: 'WEBGL',
		originalName: 'integration-webgl-source.zip',
		representations: [{
			role: 'WEBGL_SOURCE', bucket: protectedBucket, objectKey: 'integration-webgl-source.zip',
			mimeType: 'application/zip', sizeBytes: BigInt(EMPTY_ZIP.length),
		}],
	});
	const webglSourceRepresentation = await prisma.assetRepresentation.findUniqueOrThrow({
		where: { asset_representation_asset_role: { assetId: webglSource.id, role: 'WEBGL_SOURCE' } },
	});
	const deploymentId = '11111111-1111-4111-8111-111111111111';
	const publicPrefix = 'public/webgl/integration-fixture/';
	await prisma.webglDeployment.create({
		data: {
			id: deploymentId,
			projectId: webglProject.id,
			sourceRepresentationId: webglSourceRepresentation.id,
			publicBucket,
			publicPrefix,
			entryObjectKey: `${publicPrefix}index.html`,
			objectManifest: {
				version: '1',
				objects: [
					{
						objectKey: `${publicPrefix}index.html`,
						sizeBytes: Buffer.byteLength('<!doctype html><title>integration webgl</title>'),
						mimeType: 'text/html',
					},
					{
						objectKey: `${publicPrefix}Build/game.js`,
						sizeBytes: Buffer.byteLength('console.log("integration webgl")'),
						mimeType: 'application/javascript',
					},
				],
			},
			state: 'READY',
		},
	});
	await prisma.project.update({
		where: { id: webglProject.id },
		data: { currentWebglDeploymentId: deploymentId },
	});

  await prisma.project.create({
    data: {
      exhibitionId: uploadOpen.id,
      slug: 'integration-member-project',
      title: 'Integration Member Project',
      summary: 'Student is a member but not the creator.',
      status: 'PUBLISHED',
      creatorId: other.id,
      members: {
        create: [
          { name: other.name, studentId: other.studentId ?? '', userId: other.id, sortOrder: 0 },
          { name: student.name, studentId: student.studentId ?? '', userId: student.id, sortOrder: 1 },
        ],
      },
    },
  });

  console.log('통합 테스트 사용자:', student.email, operator.email, admin.email);
  console.log('통합 테스트 전시:', uploadOpen.id, uploadClosed.id, emptyExhibition.id);
	console.log('통합 테스트 canonical representation fixture: integration-poster.png');
}

// ── JSON 파일에서 실제 데이터 임포트 ──────────────────

interface ImportYear {
  year: number;
  title?: string;
  isModificationEnabled?: boolean;
}

interface ImportMember {
  name: string;
  studentId?: string;
  sortOrder?: number;
}

interface ImportProject {
  year: number;
  title: string;
  slug?: string;
  summary?: string;
  description?: string;
  isIncomplete?: boolean;
  status?: 'PUBLISHED' | 'ARCHIVED';
  githubUrl?: string;
  platforms?: ('PC' | 'MOBILE' | 'WEB')[];
  members?: ImportMember[];
}

interface ImportData {
  years?: ImportYear[];
  projects?: ImportProject[];
}

function toSlugSimple(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || 'project';
}

async function importFromJson(filePath: string, creatorId: number) {
  const raw = readFileSync(filePath, 'utf-8');
  const data: ImportData = JSON.parse(raw);

  // 전시회 생성
  const exhibitionMap = new Map<number, number>(); // year number -> exhibition id
  if (data.years) {
    for (const y of data.years) {
      const yearTitle = y.title ?? '';
      const created = await prisma.exhibition.upsert({
        where: { year_title: { year: y.year, title: yearTitle } },
        update: { isModificationEnabled: y.isModificationEnabled ?? true },
        create: { year: y.year, title: yearTitle, isModificationEnabled: y.isModificationEnabled ?? true },
      });
      exhibitionMap.set(y.year, created.id);
      console.log(`전시회: ${y.year} — ${yearTitle || '(제목 없음)'} (${created.id})`);
    }
  }

  // 프로젝트 생성
  if (data.projects) {
    let created = 0;
    let skipped = 0;

    for (const p of data.projects) {
      // 전시회가 없으면 자동 생성
      if (!exhibitionMap.has(p.year)) {
        const defaultTitle = '졸업작품 전시회';
        const ex = await prisma.exhibition.upsert({
          where: { year_title: { year: p.year, title: defaultTitle } },
          update: {},
          create: { year: p.year, title: defaultTitle, isModificationEnabled: true },
        });
        exhibitionMap.set(p.year, ex.id);
      }
      const exhibitionId = exhibitionMap.get(p.year)!;

      // slug 생성 (중복 시 번호 추가)
      const baseSlug = p.slug || toSlugSimple(p.title);
      let slug = baseSlug;
      let attempt = 0;
      while (
        await prisma.project.findUnique({
          where: { project_exhibition_slug: { exhibitionId, slug } },
        })
      ) {
        attempt++;
        slug = `${baseSlug}-${attempt}`;
      }

      if (attempt > 0 && !p.slug) {
        console.log(`  ⚠ "${p.title}" slug 충돌 → ${slug}`);
      }

      const project = await prisma.project.create({
        data: {
          exhibitionId,
          slug,
          title: p.title,
          summary: p.summary ?? '',
          description: p.description ?? '',
          isIncomplete: p.isIncomplete ?? false,
          status: p.status ?? 'PUBLISHED',
          githubUrl: p.githubUrl ?? '',
          platforms: p.platforms ?? [],
          creatorId,
          members: {
            create: (p.members ?? []).map((m, i) => ({
              name: m.name,
              studentId: m.studentId ?? '',
              sortOrder: m.sortOrder ?? i,
            })),
          },
        },
      });
      created++;
      console.log(`  프로젝트: ${project.title} (${p.year}/${slug})`);
    }

    console.log(`\n임포트 완료: ${created}개 생성, ${skipped}개 건너뜀`);
  }
}

// ── Main ──────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const importIndex = args.indexOf('--import');
  const integration = args.includes('--integration');

  console.log('━━━ PCU Graduation DB Seed ━━━\n');

  if (integration) {
    await seedIntegrationData();
    return;
  }

  // 항상 테스트 ADMIN 생성
  const { user: admin, sessionId } = await seedTestAdmin();
  console.log('');

  if (importIndex !== -1 && args[importIndex + 1]) {
    // JSON 파일에서 데이터 임포트
    const filePath = args[importIndex + 1]!;
    console.log(`"${filePath}"에서 데이터 임포트 중...\n`);
    await importFromJson(filePath, admin.id);
  } else {
    // 테스트 데이터 생성
    console.log('테스트 데이터 생성 중...\n');
    await seedTestData(admin.id);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`세션 쿠키 값: ${sessionId}`);
  console.log('브라우저 콘솔에서 로그인:');
  console.log(`document.cookie = "sid=${sessionId}; path=/; secure; samesite=none"`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main()
  .catch((e) => {
    console.error('Seed 실패:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
