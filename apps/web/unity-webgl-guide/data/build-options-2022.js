/** Same diagnostic guidance, with coordinates and labels for the retained 2022 screenshot. */
window.PcuWebglGuide.legacyBuildOptions = window.PcuWebglGuide.buildOptions
  .slice(0, 5)
  .map((option, index) => ({
    ...option,
    image: null,
    imageAlt: null,
    left: 43,
    width: 55,
    top: [41.5, 44.8, 48, 51.2, 38.4][index],
    height: 3.4,
  }));
Object.assign(window.PcuWebglGuide.legacyBuildOptions[1], {
  value: "Runtime Speed with LTO → Runtime Speed → Speed",
  text: "첫 제출에서는 드롭다운에 Runtime Speed with LTO가 있으면 선택합니다. 없고 Runtime Speed가 있으면 그것을, 이미지처럼 Speed로 표시되면 Speed를 선택합니다. 학생이 성능 실험을 해서 정할 필요는 없습니다.",
  note: "현재 2022.3 공식 설정 문서와 공식 스크린샷의 명칭이 달라 실제 메뉴에 표시되는 이름을 기준으로 안내합니다. 반복 개발에서는 빌드 시간이 짧은 모드를 사용할 수 있지만, 최종 ZIP은 제출할 설정으로 빌드하고 그 업로드본을 확인하세요.",
});

Object.assign(window.PcuWebglGuide.legacyBuildOptions[4], {
  text: "Build Settings의 Texture Compression은 Use Player Settings로 두세요. 5단계의 Player 설정에서 PC용 텍스처 압축 형식인 DXT를 선택합니다. 빌드 창에서 다른 형식을 직접 고르면 Player의 DXT 설정보다 우선합니다.",
});
