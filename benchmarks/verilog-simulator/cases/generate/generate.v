module generate_lane(input a, input b, output y);
  assign y = a ^ b;
endmodule

module generate_bench;
  integer i;
  integer bit_index;
  reg [63:0] a;
  reg [63:0] b;
  reg [63:0] expected;
  wire [63:0] y;
  genvar lane;

  generate
    for (lane = 0; lane < 64; lane = lane + 1) begin : lanes
      generate_lane lane_instance(.a(a[lane]), .b(b[63-lane]), .y(y[lane]));
    end
  endgenerate

  initial begin
    a = 0;
    b = 0;
    expected = 0;
    for (i = 0; i < 5000; i = i + 1) begin
      a = {a[62:0], a[63] ^ a[62] ^ 1'b1};
      b = {b[61:0], b[63:62] ^ 2'b01};
      for (bit_index = 0; bit_index < 64; bit_index = bit_index + 1)
        expected[bit_index] = a[bit_index] ^ b[63-bit_index];
      #1;
      if (y !== expected) begin
        $display("FAIL generate");
        $finish;
      end
    end
    $display("PASS generate");
    $finish;
  end
endmodule
