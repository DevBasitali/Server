const Guest = require("../model/guest");
const Room = require("../model/room");
const Discount = require("../model/discount");
const axios = require("axios");
const mongoose = require("mongoose");

exports.createGuest = async (req, res) => {
  try {
    const {
      fullName,
      address,
      phone,
      cnic,
      email,
      roomNumber,
      stayDuration,
      paymentMethod,
      applyDiscount = false,
    } = req.body;

    // 1. Lookup room by roomNumber
    const room = await Room.findOne({ roomNumber });
    if (!room)
      return res
        .status(404)
        .json({ success: false, message: "Room not found" });
    if (room.status !== "available")
      return res
        .status(400)
        .json({ success: false, message: "Room not available" });

    // 2. Calculate rent and discount
    const baseRent = room.rate * stayDuration;
    let totalRent = baseRent;
    let discountTitle = null;

    if (applyDiscount) {
      const today = new Date();
      const validDiscount = await Discount.findOne({
        startDate: { $lte: today },
        endDate: { $gte: today },
      });
      if (!validDiscount)
        return res
          .status(400)
          .json({
            success: false,
            message: "No valid discount available today",
          });
      totalRent = baseRent * (1 - validDiscount.percentage / 100);
      discountTitle = validDiscount.title;
    }

    // 3. Create guest record
    const guest = await Guest.create({
      fullName,
      address,
      phone,
      cnic,
      email,
      room: room._id,
      stayDuration,
      paymentMethod,
      applyDiscount,
      discountTitle,
      totalRent,
      createdBy: req.user.userId,
    });

    // 4. Mark room occupied
    room.status = "occupied";
    await room.save();

    // 5. Notify Inventory module of check-in
    try {
      await axios.post(
        `${process.env.API_BASE_URL}/api/inventory/checkin`,
        { roomId: room._id, guestId: guest._id },
        {
          headers: {
            Cookie: req.headers.cookie,
          },
        }
      );
      console.log(
        "Calling Inventory at:",
        `${process.env.API_BASE_URL}/api/inventory/checkin`
      );
    } catch (invErr) {
      console.error("Inventory check-in failed:", invErr.message);
      // Continue without blocking check-in
    }

    return res
      .status(201)
      .json({ success: true, message: "Guest checked in", data: guest });
  } catch (err) {
    console.error("createGuest Error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

exports.getGuests = async (req, res) => {
  try {
    const guests = await Guest.find()
      // pull in roomNumber, bedType, rate and status
      .populate("room", "roomNumber bedType category rate status view")
      .populate("createdBy", "name email");
    return res.status(200).json({ guests });
  } catch (err) {
    return res
      .status(500)
      .json({ message: "Server error", error: err.message });
  }
};

// Get guest by ID
exports.getGuestById = async (req, res) => {
  try {
    const guest = await Guest.findById(req.params.id)
      .populate("room", "roomNumber bedType category rate status view")
      .populate("createdBy", "name email");
    if (!guest) return res.status(404).json({ message: "Guest not found" });
    res.status(200).json({ guest });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

exports.checkoutGuest = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid guest ID" });
    }
    const guest = await Guest.findById(id);
    if (!guest) {
      return res
        .status(404)
        .json({ success: false, message: "Guest not found" });
    }
    if (guest.status === "checked-out") {
      return res
        .status(400)
        .json({ success: false, message: "Guest already checked out" });
    }

    // mark checkout timestamp
    const now = new Date();
    guest.checkOutAt = now;
    guest.checkOutTime = now.toTimeString().slice(0, 5);
    guest.status = "checked-out";

    // recalc stay duration
    const inMs = guest.checkInAt.getTime();
    const outMs = now.getTime();
    guest.stayDuration = Math.ceil((outMs - inMs) / (1000 * 60 * 60 * 24));
    await guest.save();

    // free up the room
    const room = await Room.findById(guest.room);
    if (room) {
      room.status = "available";
      await room.save();
    }

    // Notify Inventory module of check-out
    try {
      await axios.post(
        `${process.env.API_BASE_URL}/api/inventory/checkout`,
        { roomId: guest.room, guestId: guest._id },
        {
          headers: {
            Cookie: req.headers.cookie,
          },
        }
      );
      console.log(
        "Calling Inventory at:",
        `${process.env.API_BASE_URL}/api/inventory/checkout`
      );
    } catch (invErr) {
      console.error("Inventory check-out failed:", invErr.message);
      // Continue without blocking check-out
    }

    return res
      .status(200)
      .json({ success: true, message: "Guest checked out", data: guest });
  } catch (err) {
    console.error("checkoutGuest Error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

exports.deleteGuest = async (req, res) => {
  try {
    const guest = await Guest.findByIdAndDelete(req.params.id);
    if (!guest) {
      return res.status(404).json({ message: "Guest not found" });
    }
    return res.json({ message: "Guest deleted successfully" });
  } catch (err) {
    console.error("deleteGuest Error:", err);
    return res
      .status(500)
      .json({ message: "Server error", error: err.message });
  }
};

exports.getCheckedInGuestsByRoomCategory = async (req, res, next) => {
  try {
    const { category } = req.query;

    if (!category) {
      return res.status(400).json({
        success: false,
        error: "Please provide a room category",
      });
    }

    // First, find all rooms of the specified category
    const roomsInCategory = await Room.find({ category: category }).select('_id');
    const roomIds = roomsInCategory.map(room => room._id);

    if (roomIds.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        data: [],
        message: `No rooms found for category: ${category}`
      });
    }

    // Now find all guests who are:
    // 1. Currently checked-in (status: "checked-in")
    // 2. In one of the rooms from our category
    const checkedInGuests = await Guest.find({
      status: "checked-in",
      room: { $in: roomIds }
    })
    .populate('room', 'roomNumber bedType view rate') // Include room details
    .populate('createdBy', 'name email') // Include admin who created the booking
    .sort({ checkInAt: -1 }); // Most recent check-ins first

    res.status(200).json({
      success: true,
      category: category,
      count: checkedInGuests.length,
      data: checkedInGuests,
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: "Server Error" });
  }
};