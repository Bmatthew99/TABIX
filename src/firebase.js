// src/firebase.js
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

// Ваши настройки Firebase — замените на свои
const firebaseConfig = {
  apiKey: "AIzaSyDraCRudKqu46FUSVRagLBbXgFKmGuRzKs",
  authDomain: "ordersapp-82d1c.firebaseapp.com",
  projectId: "ordersapp-82d1c",
  storageBucket: "ordersapp-82d1c.firebasestorage.app",
  messagingSenderId: "721565116595",
  appId: "1:721565116595:web:1a0a90ca3180fd8757a8c6",
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const firestore = getFirestore(app);
export const storage = getStorage(app);
