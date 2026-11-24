import 'dotenv/config'; import mongoose from 'mongoose'; import bcrypt from 'bcryptjs'; import { User, Settings } from '../src/models/index.js';
if(!process.env.MONGODB_URI) throw Error('MONGODB_URI is required'); await mongoose.connect(process.env.MONGODB_URI);
const users=[['مالك الشركة','owner','owner123','owner'],['المحاسب الرئيسي','accountant','acc123','accountant'],['مدير المشاريع','manager','mgr123','manager'],['مستخدم تجريبي (مشاهدة فقط)','viewer','view123','viewer']];
for(const [name,username,password,role] of users){if(!await User.findOne({username}))await User.create({name,username,role,passwordHash:await bcrypt.hash(password,12),mustChangePassword:true});}
if(!await Settings.findOne())await Settings.create({}); console.log('Seed complete. Every initial account must change its password at first login.');await mongoose.disconnect();
