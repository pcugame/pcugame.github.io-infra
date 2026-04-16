-- 전시회 이름 변경: "YYYY 졸업작품전" → "졸업작품 전시회"
-- 연도는 프론트엔드에서 ex.year로 별도 표시되므로 title에서 제거
UPDATE exhibitions SET title = '졸업작품 전시회' WHERE title LIKE '% 졸업작품전';