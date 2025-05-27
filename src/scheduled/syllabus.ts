import { parseHTML } from "linkedom/worker";
import { fullWidthToHalfWidth } from "../utils/characters";
import supabase_server, { supabaseWithEnv } from "../config/supabase_server";
import type { Context } from "hono";
import algolia, { algoliaWithEnv } from "../config/algolia";

interface Department {
  code: string;
  name_zh: string;
  name_en: string;
}

interface Course {
  capacity: number | null;
  course: string;
  department: string;
  semester: string;
  class: string;
  name_en: string;
  name_zh: string;
  teacher_en: string[] | null;
  teacher_zh: string[];
  credits: number;
  reserve: number;
  ge_type: string;
  ge_target?: string;
  language: string;
  compulsory_for: string[];
  elective_for: string[];
  venues: string[];
  times: string[];
  first_specialization: string[];
  second_specialization: string[];
  cross_discipline: string[];
  tags: string[];
  no_extra_selection: boolean;
  note: string;
  closed_mark: string;
  prerequisites: string;
  restrictions: string;
  raw_id: string;
  enrolled: number;
  updated_at: string;
}

const baseUrl = `https://www.ccxp.nthu.edu.tw/ccxp/INQUIRE/JH/6/6.2/6.2.9/JH629002.php`;

export const scrapeArchivedCourses = async (env: Env, semester: string) => {
  const landingPageRes = await fetch(
    "https://www.ccxp.nthu.edu.tw/ccxp/INQUIRE/JH/6/6.2/6.2.9/JH629001.php",
    { cf: { cacheTtl: 0 } },
  )
    .then((res) => res.arrayBuffer())
    .then((arrayBuffer) =>
      new TextDecoder("big5").decode(new Uint8Array(arrayBuffer)),
    );

  // search for the text https://www.ccxp.nthu.edu.tw/ccxp/INQUIRE/JH/mod/auth_img/auth_img.php?ACIXSTORE=643u4hfveif4and3kbudjqusu7
  const acixStoreMatch = landingPageRes.match(
    /auth_img\.php\?ACIXSTORE=([a-zA-Z0-9]+)/,
  );
  if (!acixStoreMatch) {
    throw new Error("ACIXSTORE not found in landing page");
  }
  const acixStore = acixStoreMatch[1];

  const ocrResults = await fetch(
    `https://ocr.nthumods.com/?url=https://www.ccxp.nthu.edu.tw/ccxp/INQUIRE/JH/mod/auth_img/auth_img.php?ACIXSTORE=${acixStore}&d=3`,
  ).then((res) => res.text());
  if (ocrResults.length != 3) {
    throw new Error("OCR results are not valid, please try again later");
  }
  const webLanding = parseHTML(landingPageRes).document;

  // Extract department options from the select element
  const selectElement = webLanding.querySelector('select[name="cou_code"]');
  const optionElements = selectElement?.querySelectorAll("option") || [];

  let departments: Department[] = [];

  console.log(`Found select element: ${!!selectElement}`);
  console.log(`Found ${optionElements.length} option elements`);

  optionElements.forEach((option, index) => {
    const value = option.getAttribute("value");
    const text = option.textContent?.trim();

    // Skip empty values or the first instructional option
    if (
      !value ||
      value === "" ||
      text?.startsWith("開課代號") ||
      text?.includes("請選擇開課代號")
    ) {
      return;
    }

    // Parse the department code and name
    const code = value.trim();

    // Extract Chinese and English names from the text
    // Based on the HTML sample, format appears to be: "CODE　Chinese Name English Name"
    if (text) {
      // Split by full-width space (　)
      const parts = text.split("　");

      if (parts.length >= 2) {
        // First part should be the code, second part contains names
        const namesPart = parts[1].trim();

        // Split names part by regular space to separate Chinese and English
        const nameWords = namesPart.split(/\s+/);
        const chineseName = nameWords[0] || "";
        const englishName = nameWords.slice(1).join(" ") || "";

        departments.push({
          code: code,
          name_zh: chineseName,
          name_en: englishName,
        });
      } else {
        // Fallback: if no full-width space, try to parse differently
        const spaceIndex = text.indexOf(" ");
        if (spaceIndex > 0) {
          const chinesePart = text.substring(0, spaceIndex);
          const englishPart = text.substring(spaceIndex + 1).trim();

          departments.push({
            code: code,
            name_zh: chinesePart.replace(code, "").trim(),
            name_en: englishPart,
          });
        } else {
          // Last fallback: just use the text as Chinese name
          departments.push({
            code: code,
            name_zh: text.replace(code, "").trim(),
            name_en: "",
          });
        }
      }
    }
  });

  const skippedDepartments = ["X", "XA", "XZ", "YZ"];
  // Filter out departments that are in the skipped list
  departments = departments.filter(
    (department) => !skippedDepartments.includes(department.code.trim()),
  );

  console.log(`Found ${departments.length} departments`);

  const fetchCourses = async (department: Department, yearSemester: string) => {
    const response = await fetch(baseUrl, {
      body: new URLSearchParams({
        "cache-control": "max-age=0",
        ACIXSTORE: `${acixStore}`,
        YS: `${yearSemester.slice(0, 3)}|${yearSemester.slice(3, 5)}`,
        cond: "a",
        cou_code: `${department.code}`,
        auth_num: `${ocrResults}`,
      }),
      method: "POST",
      cf: { cacheTtl: 0 },
    });
    return response;
  };

  const normalizedCourses: Course[] = [];

  await Promise.all(
    departments.map(async (department) => {
      console.log(`Scraping ${department.code} ${semester}...`);

      const text = await fetchCourses(department, semester)
        .then((res) => res.arrayBuffer())
        .then((arrayBuffer) =>
          new TextDecoder("big5").decode(new Uint8Array(arrayBuffer)),
        );
      const doc = parseHTML(text).document;

      const table = Array.from(doc.querySelectorAll("table")).find((n) =>
        (n.textContent?.trim() ?? "").startsWith("科號"),
      );

      const rows = Array.from(table?.querySelectorAll("tr") ?? []);
      for (let i = 2; i < rows.length; i += 2) {
        const row = rows[i];
        const cells = row.querySelectorAll("td");

        const course_id = cells[0].textContent?.trim() ?? "";
        if (course_id === "") {
          continue;
        }

        const course_name = cells[1].innerHTML
          .split("<br>")
          .map((text) => text.trim());
        const course_name_zh = course_name[0];
        const course_name_en = course_name[1];
        const course_ge_type = course_name[2];

        const credit = cells[2].textContent?.trim() ?? "0";

        const time: string[] = [];
        if (cells[3].textContent?.trim()) {
          time.push(cells[3].textContent?.trim());
        }

        const venues: string[] = [];
        if (cells[4].textContent?.split("／")[0].trim()) {
          venues.push(cells[4].textContent?.split("／")[0].trim());
        }

        const teacher_en: string[] = [];
        const teacher_zh: string[] = [];
        const teacher_names = cells[5].innerHTML.split("<br>").map((text) =>
          text
            .replace(/<[^>]*>/g, "")
            .replace(/&nbsp;/gi, " ")
            .replace(/&#160;/g, "")
            .trim(),
        );

        teacher_names.forEach((name, index) => {
          if (index % 2 === 0) {
            teacher_zh.push(name);
          } else {
            teacher_en.push(name);
          }
        });

        let reserve = 0;
        const size_limit = cells[6].textContent?.trim() ?? "";
        if (size_limit.includes("新生保留")) {
          reserve = parseInt(size_limit.split("新生保留")[1].replace("人", ""));
        }

        const note = cells[7].textContent?.trim() ?? "";
        const normalizedNote = fullWidthToHalfWidth(note);

        let course_restriction = "";
        const cross_discipline: string[] = [];
        const first_specialty: string[] = [];
        const second_specialty: string[] = [];
        let remark = "";

        const note_html = cells[7].innerHTML.split("<br>");

        note_html.forEach((text) => {
          if (text.includes('<font color="black">')) {
            let cleanedText = text
              .replace(/<[^>]*>/g, "")
              .replace(/&nbsp;/gi, " ")
              .trim();

            course_restriction = cleanedText;
          } else if (text.includes('<font color="blue">')) {
            let cleanedText = text
              .replace(/<[^>]*>/g, "")
              .replace(/&nbsp;/gi, " ")
              .trim();

            cleanedText.split("/").forEach((text) => {
              cross_discipline.push(text.replace("(跨領域)", ""));
            });
          } else if (text.includes('<font color="#5F04B4">')) {
            let cleanedText = text
              .replace(/<[^>]*>/g, "")
              .replace(/&nbsp;/gi, " ")
              .trim();

            cleanedText.split("/").forEach((text) => {
              if (text.includes("(第一專長)")) {
                first_specialty.push(text.replace("(第一專長)", ""));
              } else if (text.includes("(第二專長)")) {
                second_specialty.push(text.replace("(第二專長)", ""));
              }
            });
          } else if (text.includes('<font color="#0404B4">')) {
            let cleanedText = text
              .replace(/<[^>]*>/g, "")
              .replace(/&nbsp;/gi, " ")
              .trim();
            // replace empty string case to be ' ' so that it will be exactly
            // the same as sync-courses function
            if (cleanedText !== "") remark = cleanedText;
            else remark = " ";
          }
        });

        const tags = [];
        const weeks = normalizedNote.includes("16")
          ? 16
          : normalizedNote.includes("18")
            ? 18
            : 0;
        if (weeks != 0) tags.push(weeks + "週");
        const hasXClass = normalizedNote.includes("X-Class") ? true : false;
        if (hasXClass) tags.push("X-Class");
        const no_extra_selection = normalizedNote.includes(
          "《不接受加簽 No extra selection》",
        );
        if (no_extra_selection) tags.push("不可加簽");

        const enrollment = cells[8].textContent?.trim() ?? "";

        // replace empty string case to be ' ' so that it will be exactly
        // the same as sync-courses function
        let object = cells[9].textContent?.trim();
        if (object === "") {
          object = " ";
        }

        const comp: string[] = [];
        const elect: string[] = [];

        const required_optional_note_cell = rows[i + 1]
          .querySelectorAll("td")[0]
          .textContent?.trim()
          .replace("/", "");
        const required_optional_note = required_optional_note_cell
          ?.split(",")
          .filter((text) => text.trim() !== "");

        required_optional_note?.forEach((note) => {
          if (note.includes("必修")) {
            comp.push(note.replace("必修", "").trim());
          } else {
            elect.push(note.replace("選修", "").trim());
          }
        });

        const prerequisites = cells[10].textContent?.trim() ?? "";

        //check if the course is already added
        if (
          normalizedCourses.find((course: any) => course.raw_id === course_id)
        )
          continue;

        const normalizedCourse = {
          capacity: parseInt(size_limit),
          course: course_id.slice(9, 13),
          department: course_id.slice(5, 9).trim(),
          semester: course_id.slice(0, 5),
          class: parseInt(course_id.slice(13, 15)).toString(),
          name_en: course_name_en,
          name_zh: course_name_zh,
          teacher_en: teacher_en,
          teacher_zh: teacher_zh,
          credits: parseInt(credit),
          reserve: reserve,
          ge_type: course_ge_type,
          ge_target: object,
          language: note.includes("/Offered in English") ? "英" : "中",
          compulsory_for: comp,
          elective_for: elect,
          venues: venues,
          times: time,
          first_specialization: first_specialty,
          second_specialization: second_specialty,
          cross_discipline: cross_discipline,
          tags: tags,
          no_extra_selection: note.includes(
            "《不接受加簽 No extra selection》",
          ),
          note: remark,
          closed_mark: "",
          prerequisites: prerequisites,
          restrictions: course_restriction,
          raw_id: course_id,
          enrolled: parseInt(enrollment) ?? 0,
          updated_at: new Date().toISOString(),
        } satisfies Course;
        normalizedCourses.push(normalizedCourse);
      }
    }),
  );
  console.log(`Found ${normalizedCourses.length} courses in ${semester}`);

  // update supabase, check if the course with the same raw_id exists, if so, update it, otherwise insert it
  //split array into chunks of 1000

  const chunked = normalizedCourses.reduce((acc, cur, i) => {
    const index = Math.floor(i / 500);
    acc[index] = acc[index] || [];
    acc[index].push(cur);
    return acc;
  }, [] as Course[][]);
  for (const chunk of chunked) {
    const { error } = await supabaseWithEnv(
      env.SUPABASE_URL,
      env.SUPABASE_SERVICE_ROLE_KEY,
    )
      .from("courses")
      .upsert(chunk);
    if (error) throw error;
  }

  return normalizedCourses;
};

const downloadPDF = async (env: Env, url: string, c_key: string) => {
  //get url+c_key file as a arrayBuffer
  const file = await fetch(url, { cf: { cacheTtl: 0 } })
    .then((res) => res.arrayBuffer())
    .then((arrayBuffer) => Buffer.from(arrayBuffer));
  //save file to local fs
  // await fs.writeFileSync(c_key + '.pdf', file)
  await supabaseWithEnv(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
    .storage.from("syllabus")
    .upload(c_key + ".pdf", file, {
      cacheControl: (60 * 60 * 24 * 30).toString(), // cache the file for 30days
      upsert: true,
      contentType: "application/pdf",
    })
    .then((res) => {
      console.log(res);
    });
};

const parseContent = async (env: Env, html: string, c_key: string) => {
  console.log("parsing " + c_key);
  const doc = parseHTML(html).document;
  const brief = doc
    .querySelectorAll("table")[4]
    ?.querySelector(".class2")?.textContent;
  const keywords = doc.querySelector("p")?.textContent;
  let content = null;
  if (
    doc
      .querySelectorAll("table")[5]
      ?.querySelector(".class2")
      ?.textContent?.includes("觀看上傳之檔案(.pdf)")
  ) {
    const url =
      "https://www.ccxp.nthu.edu.tw" +
      doc
        .querySelectorAll("table")[5]
        ?.querySelector(".class2 a")
        ?.getAttribute("href");
    downloadPDF(env, url, c_key);
  } else {
    content = doc
      .querySelectorAll("table")[5]
      ?.querySelector(".class2")?.textContent;
  }

  return { brief, keywords, content };
};

const getAnonACIX = async () => {
  const url =
    "https://www.ccxp.nthu.edu.tw/ccxp/INQUIRE/JH/6/6.2/6.2.6/JH626001.php";
  //the url should return a 302 redirect to a url with ACIXSTORE as `JH626001.php?ACIXSTORE=xxxx`
  const ACIXSTORE = await fetch(url, { redirect: "manual" })
    .then((res) => res.headers.get("location"))
    .then((location) => location?.split("=")[1]);
  return ACIXSTORE;
};

export const scrapeSyllabus = async (
  env: Env,
  semester: string,
  cachedCourses?: Course[],
) => {
  const fetchCourses = async () => {
    const { data, error } = await supabaseWithEnv(
      env.SUPABASE_URL,
      env.SUPABASE_SERVICE_ROLE_KEY,
    )
      .from("courses")
      .select("raw_id")
      .eq("semester", semester)
      .order("raw_id", { ascending: true });
    if (error) throw error;
    return data;
  };

  const ACIXSTORE = await getAnonACIX();

  if (ACIXSTORE === null)
    throw new Error("Failed to fetch ACIXSTORE, please try again later");

  const baseURL = `https://www.ccxp.nthu.edu.tw/ccxp/INQUIRE/JH/common/Syllabus/1.php?ACIXSTORE=${ACIXSTORE}&c_key=`;

  const fetchSyllabusHTML = async (c_key: string) => {
    const text = await fetch(baseURL + encodeURIComponent(c_key))
      .then((res) => res.arrayBuffer())
      .then((arrayBuffer) =>
        new TextDecoder("big5").decode(new Uint8Array(arrayBuffer)),
      );
    return text;
  };
  const courses = cachedCourses ?? (await fetchCourses());

  const processCourse = async (course: any) => {
    const { raw_id } = course;
    // skip YZ courses
    if (raw_id.slice(5, 7) === "YZ") return;

    const html = await fetchSyllabusHTML(raw_id);
    const {
      brief: _brief,
      keywords,
      content: _content,
    } = await parseContent(env, html, raw_id);
    // sanitize brief and content to remove all <x> instances
    const brief = _brief?.replace(/<[^>]*>/g, "").trim() || null;
    const content = _content?.replace(/<[^>]*>/g, "").trim() || null;

    console.log("scrapped", raw_id);
    const { error } = await supabaseWithEnv(
      env.SUPABASE_URL,
      env.SUPABASE_SERVICE_ROLE_KEY,
    )
      .from("course_syllabus")
      .upsert({
        raw_id,
        brief,
        keywords: keywords?.split(",") ?? [],
        content,
        has_file: content === null ? true : false,
        updated_at: new Date().toISOString(),
      });

    if (cachedCourses) {
      // sync to algolia as well
      const algoliaCourse = {
        ...course,
        brief,
        keywords: keywords?.split(",") ?? [],
        content,
        objectID: raw_id,
        for_class: [
          ...(course.elective_for || []),
          ...(course.compulsory_for || []),
        ],
        separate_times: course.times.flatMap((s: string) => s.match(/.{1,2}/g)),
        courseLevel: course.course[0] + "000",
      };
      algoliaWithEnv(env.ALGOLIA_APP_ID, env.ALGOLIA_API_KEY).saveObject(
        algoliaCourse,
      );
    }

    if (error) throw error;
  };

  // Process courses with concurrency limit of 50
  const concurrencyLimit = 20;
  for (let i = 0; i < courses.length; i += concurrencyLimit) {
    const batch = courses.slice(i, i + concurrencyLimit);
    await Promise.all(batch.map(processCourse));
  }
  console.log(
    `Scraped syllabus for ${courses.length} courses in semester ${semester}`,
  );
};

export const syncCoursesToAlgolia = async (env: Env, semester: string) => {
  const query = await supabaseWithEnv(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
  )
    .from("courses")
    .select("*, course_syllabus(brief, keywords)")
    .eq("semester", semester);

  if (!query.data) throw new Error("no data found");

  const chunked = query.data
    .map((m) => ({ ...m, ...m.course_syllabus }))
    .reduce((acc, cur, i) => {
      const index = Math.floor(i / 500);
      acc[index] = acc[index] || [];
      acc[index].push(cur! as Course);
      return acc;
    }, [] as Course[][]);

  for (const chunk of chunked) {
    const algoliaChunk = chunk.map(
      ({ elective_for, compulsory_for, ...course }) => ({
        ...course,
        for_class: [...(elective_for || []), ...(compulsory_for || [])],
        objectID: course.raw_id,
        separate_times: course.times.flatMap((s) => s.match(/.{1,2}/g)),
        courseLevel: course.course[0] + "000",
      }),
    );
    algoliaWithEnv(env.ALGOLIA_APP_ID, env.ALGOLIA_API_KEY).saveObjects(
      algoliaChunk,
    );
  }
};
