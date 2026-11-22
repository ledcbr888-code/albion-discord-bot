# PR #54 — บันทึกสาเหตุ AlbionZvZ Fallback แบบจำกัดพื้นที่

**จุดประสงค์:** เก็บหลักฐาน Battle ใหม่ ว่าเหตุใดบอทใช้ Official แทน AlbionZvZ
กรณีเก่า Battle `531552720` ย้อน Log คืนไม่ได้; ไม่ดึงข้อมูลใหม่ไปเดาสาเหตุ

## ข้อมูลที่จัดเก็บ

- Event `BUDGET_WAIT`: โควตา AlbionZvZ Detail 3/นาทีเต็มและบอทรอรอบถัดไป
- Event `CAPACITY_EXPIRED`: รอครบ 120 วินาทีแล้ว
- Event `FALLBACK`: `PrimaryReason`, `Result`, Battle ID, กิลด์, จำนวนผู้เล่น
  ที่พบใน AlbionZvZ, จำนวนที่ AlbionZvZ รายงานไว้, จำนวนใน List
  และจำนวนผู้เล่นจาก Official (ถ้าดึงสำเร็จ)
- ข้อมูลไม่ครบ: `LIST_PLAYER_COUNT_MISMATCH`,
  `DETAIL_PLAYER_COUNT_MISMATCH` หรือ `OTHER_VALIDATION`
- ไม่บันทึก response เต็ม, ชื่อผู้เล่น, Equipment, HTTP headers, Credentials,
  tokens หรือ tracking snapshots

## ขอบเขตพื้นที่และความปลอดภัย

- เก็บใน `<folder of TRACKING_FILE>/.bossbot-diagnostics/`; ถ้าไม่กำหนด
  TRACKING_FILE ใช้ `DATA_DIR/.bossbot-diagnostics/`
- **2 ไฟล์เท่านั้น**: `albionzvz-detail.jsonl`, `albionzvz-detail.previous.jsonl`
- **256 KiB/ไฟล์** รวม **ไม่เกิน 512 KiB** ในสภาวะที่ระบบจัดการเองตามปกติ
- **512 bytes ต่อรายการ**, สูงสุด **30 รายการ/นาที**, Memory queue <=128
  และระงับเหตุการณ์ซ้ำ (Battle/กิลด์/เหตุผล/ผล) ภายใน 1 นาที
- ลบ Log ที่อายุมากกว่า **7 วัน เมื่อมีการเขียนครั้งถัดไป** (ตรวจทุกชั่วโมง)
  และหมุนไฟล์เมื่อเต็ม; ระบบจะลบหลักฐานเก่าก่อน ไม่เก็บย้อนหลังไม่จำกัด
- เขียนแบบ batch best-effort ประมาณทุก 1 วินาที; ถ้า Disk เขียนไม่ได้
  จะข้าม Log และแจ้งเตือนสูงสุด 1 ครั้ง/10 นาที โดยไม่บล็อก Discord
- ไม่แก้ Supabase และไม่เพิ่มตาราง/แถว/Backup traffic บน GitHub
- `.gitignore` ป้องกันนำไฟล์ Log ขึ้น GitHub โดยบังเอิญ

## ก่อน Deploy

ตรวจ File Manager ของ CoalByte ว่า `TRACKING_FILE` หรือ `DATA_DIR`
อยู่บนพื้นที่ที่คงอยู่หลัง Restart; GitHub CI ไม่สามารถยืนยัน Volume จริงได้
และต้องตรวจพื้นที่ว่าง/สิทธิ์เขียนก่อนใช้งาน

## ไม่เปลี่ยนพฤติกรรมเดิม

AlbionZvZ 3 Detail/60s, เว้นคำขอ 3.5s, 120s queue, Official fallback,
Discord send/reports, Tracking, CTA, AVA, Bandit, Vercel และ Supabase
ไม่เปลี่ยน ตรวจสอบแล้วค่อยขออนุมัติ Merge/Deploy PR #54 แยกต่างหาก
