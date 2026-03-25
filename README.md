# Stock QR Tracking MVP

MVP นี้ทำตามลำดับที่วางไว้:

1. `ฐานข้อมูลหลัก`
2. `Flow สแกนรับเข้า/เบิกออก`
3. `ประวัติย้อนหลัง`
4. `Dashboard คงเหลือ`

## วิธีรัน

```powershell
node server.js
```

จากนั้นเปิด [http://localhost:3000](http://localhost:3000)

## ตัวอย่าง QR ที่ลองได้ทันที

- `PT-1002`
- `PT-2004`
- `BX-00045`
- `WO-20260325-01`
- `JOB-20260325-01`

## หมายเหตุ

- `schema.sql` เป็นโครงสร้างฐานข้อมูลจริง
- แอปตัวอย่างนี้ใช้ `data/store.json` เป็น storage เพื่อเริ่มทดสอบได้เร็ว
- ถ้าจะขึ้นใช้งานจริง ให้ย้าย API ไปต่อกับ PostgreSQL หรือ MySQL

## Deploy ไป Render

- โปรเจกต์นี้รองรับ Render แล้วผ่าน `render.yaml`
- Start command คือ `npm start`
- เซิร์ฟเวอร์อ่านพอร์ตจาก `PORT` อัตโนมัติ
