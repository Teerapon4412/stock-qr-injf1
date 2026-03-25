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
- ถ้ามี `DATABASE_URL` ระบบจะใช้ PostgreSQL อัตโนมัติ
- ถ้าไม่มี `DATABASE_URL` ระบบจะ fallback ไปใช้ `data/store.json`

## Deploy ไป Render

- โปรเจกต์นี้รองรับ Render แล้วผ่าน `render.yaml`
- Start command คือ `npm start`
- เซิร์ฟเวอร์อ่านพอร์ตจาก `PORT` อัตโนมัติ
- มี `health check` ที่ `/health`
- `render.yaml` รองรับการสร้าง Render PostgreSQL และผูกค่า `DATABASE_URL` ให้อัตโนมัติ

## ใช้ PostgreSQL บน Render

1. สร้าง PostgreSQL database บน Render หรือใช้จาก `render.yaml`
2. ตั้งค่า environment variable ชื่อ `DATABASE_URL` ให้กับ web service
3. Redeploy service

เมื่อ service start ขึ้นมา:

- ระบบจะสร้างตารางให้อัตโนมัติถ้ายังไม่มี
- จะ seed ข้อมูลตัวอย่างให้ครั้งแรก
- หลังจากนั้นข้อมูล transaction และ stock balance จะถูกเก็บใน PostgreSQL จริง
