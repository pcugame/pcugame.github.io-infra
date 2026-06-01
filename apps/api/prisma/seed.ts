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

import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

if (process.env.NODE_ENV === 'production') {
  console.error('ERROR: seed must not run in production');
  process.exit(1);
}

const prisma = new PrismaClient();

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
    create: { year: 2026, title: '졸업작품 전시회', isUploadEnabled: true },
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
  'integration-archived',
  'integration-student-owned',
  'integration-member-project',
  'integration-other-owned',
  'integration-incomplete',
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

  await prisma.asset.deleteMany({
    where: {
      storageKey: {
        in: [
          'integration-poster.png',
          'integration-image.png',
          'integration-video.mp4',
          'integration-game.zip',
        ],
      },
    },
  });
  await prisma.project.deleteMany({ where: { slug: { in: INTEGRATION_PROJECT_SLUGS } } });
  await prisma.exhibition.deleteMany({
    where: {
      OR: INTEGRATION_EXHIBITIONS.map((item) => ({ year: item.year, title: item.title })),
    },
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
  await uploadIntegrationObject(s3, publicBucket, 'integration-exhibition-poster.png', ONE_BY_ONE_PNG, 'image/png');
  await uploadIntegrationObject(s3, publicBucket, 'integration-poster.png', ONE_BY_ONE_PNG, 'image/png');
  await uploadIntegrationObject(s3, publicBucket, 'integration-image.png', ONE_BY_ONE_PNG, 'image/png');
  await uploadIntegrationObject(s3, protectedBucket, 'integration-video.mp4', TINY_MP4, 'video/mp4');
  await uploadIntegrationObject(s3, protectedBucket, 'integration-game.zip', EMPTY_ZIP, 'application/zip');

  const uploadOpen = await prisma.exhibition.create({
    data: {
      year: 2026,
      title: 'Integration Upload Open',
      isUploadEnabled: true,
      sortOrder: 0,
      posterStorageKey: 'integration-exhibition-poster.png',
      posterOriginalName: 'integration-exhibition-poster.png',
      posterMimeType: 'image/png',
      posterSizeBytes: BigInt(ONE_BY_ONE_PNG.length),
    },
  });
  const uploadClosed = await prisma.exhibition.create({
    data: {
      year: 2027,
      title: 'Integration Upload Closed',
      isUploadEnabled: false,
      sortOrder: 1,
    },
  });
  const emptyExhibition = await prisma.exhibition.create({
    data: {
      year: 2028,
      title: 'Integration Empty Exhibition',
      isUploadEnabled: true,
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

  const poster = await prisma.asset.create({
    data: {
      projectId: publicProject.id,
      kind: 'POSTER',
      storageKey: 'integration-poster.png',
      originalName: 'integration-poster.png',
      mimeType: 'image/png',
      sizeBytes: BigInt(ONE_BY_ONE_PNG.length),
      isPublic: true,
    },
  });
  await prisma.project.update({
    where: { id: publicProject.id },
    data: { posterAssetId: poster.id },
  });
  await prisma.asset.createMany({
    data: [
      {
        projectId: publicProject.id,
        kind: 'IMAGE',
        storageKey: 'integration-image.png',
        originalName: 'integration-image.png',
        mimeType: 'image/png',
        sizeBytes: BigInt(ONE_BY_ONE_PNG.length),
        isPublic: true,
      },
      {
        projectId: publicProject.id,
        kind: 'VIDEO',
        storageKey: 'integration-video.mp4',
        originalName: 'integration-video.mp4',
        mimeType: 'video/mp4',
        sizeBytes: BigInt(TINY_MP4.length),
        playbackStatus: 'READY',
        isPublic: false,
      },
      {
        projectId: publicProject.id,
        kind: 'GAME',
        storageKey: 'integration-game.zip',
        originalName: 'integration-game.zip',
        mimeType: 'application/zip',
        sizeBytes: BigInt(EMPTY_ZIP.length),
        playbackStatus: 'READY',
        isPublic: false,
      },
    ],
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
    ],
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
  console.log('통합 테스트 fixture asset: /api/assets/public/integration-poster.png');
}

// ── JSON 파일에서 실제 데이터 임포트 ──────────────────

interface ImportYear {
  year: number;
  title?: string;
  isUploadEnabled?: boolean;
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
        update: { isUploadEnabled: y.isUploadEnabled ?? true },
        create: { year: y.year, title: yearTitle, isUploadEnabled: y.isUploadEnabled ?? true },
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
          create: { year: p.year, title: defaultTitle, isUploadEnabled: true },
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
    const filePath = args[importIndex + 1];
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
