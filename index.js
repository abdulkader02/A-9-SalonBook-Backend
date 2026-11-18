
import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { MongoClient } from 'mongodb';

const app = express();
const port = 5000;

app.use(express.json());
app.use(cors());

const client = new MongoClient(process.env.MONGODB_URI);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log('You successfully connected to MongoDB!');
    return client;
  } catch (err) {
    console.error('MongoDB connection failed:', err);
    throw err;
  }
}

const connectedClient = await connectToMongoDB();
const db = connectedClient.db("salonbook")
const users = db.collection("user")

app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.get('/users', async (req, res) => {
  const allUsers = await users.find().toArray();
  res.json(allUsers)
  
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
