const mongoose = require("mongoose");

const reservationSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true },
    address: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    cnic: { type: String, required: true, trim: true },
    room: { type: mongoose.Schema.Types.ObjectId, ref: "Room", required: true },
    guest: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Guest",
      default: null,
    },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    expectedArrivalTime: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ["reserved", "checked-in", "cancelled", "checked-out"],
      default: "reserved",
    },
    source: {
      type: String,
      enum: ["CRM", "Website", "API"],
      default: "CRM",
    },
    specialRequest: { type: String, trim: true },
    paymentMethod: {
      type: String,
      enum: ["Cash", "Card", "Online", "PayAtHotel"],
    },
    promoCode: { type: String, trim: true },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("reservation", reservationSchema);
